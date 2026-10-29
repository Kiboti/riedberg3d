"""Hessen LoD2-CityGML (HVBG, dl-de/by-2-0) -> Binär-Mesh für three.js.
Pro Vertex: Position (int16, 0,1 m), Normale (int8), Klasse (uint8), Gebäudeindex (uint16), UV3 (float32):
  Dach  : (u,v) = Luftbild-UV aus UTM-Koordinaten (exakt wie Geländetextur), w = 0
  Wand  : u = horizontale Position relativ zur Wandmitte (m), v = Höhe über Gebäudesockel (m), w = halbe Wandbreite (m)
Klasse: bit0 Dach, bit1-2 Kategorie (Wohnen/Gewerbe/öffentlich/sonst), bit3 keine Fenster, bit4 Glas/Hochschule-Stil."""
import glob, json, math, sys
import numpy as np
from lxml import etree
from pyproj import Transformer
import mapbox_earcut as earcut

CFG = json.load(open(sys.argv[1]))
LON0, LAT0 = CFG['origin']; H0 = CFG['h0']; W, S, E, N = CFG['bbox']
X0, Y0, X1, Y1 = CFG['utm_bbox']
R = 6378137.0
MLON = 2*math.pi*R/360*math.cos(math.radians(LAT0)); MLAT = 2*math.pi*R/360
tr = Transformer.from_crs(25832, 4326, always_xy=True)
NS = {'gml': 'http://www.opengis.net/gml', 'bldg': 'http://www.opengis.net/citygml/building/1.0'}
G = '{http://www.opengis.net/gml}'; B = '{http://www.opengis.net/citygml/building/1.0}'
NOWIN = {'2463', '1313'}          # Garage, Gartenhaus
GLASSY = {'3020', '3023', '3024'}  # Bildung/Forschung, Hochschule, Forschungsinstitut

def local(a):
    lon, lat = tr.transform(a[:, 0], a[:, 1]); lon = np.asarray(lon); lat = np.asarray(lat)
    return np.stack([(lon-LON0)*MLON, (lat-LAT0)*MLAT, a[:, 2]-H0], 1), lon, lat

def ring(el):
    a = np.array(el.find('.//gml:posList', NS).text.split(), float).reshape(-1, 3)
    if len(a) > 1 and np.allclose(a[0], a[-1]): a = a[:-1]
    return a

pos, nrm, cls, idx, bix, uvs = [], [], [], [], [], []
nv = 0; seen = set(); feats = []

def add_polygon(rings_utm, roof, flags, bi, zbase):
    global nv
    rings = [local(r)[0] for r in rings_utm]
    allp = np.concatenate(rings); allu = np.concatenate(rings_utm)
    if len(allp) < 3: return
    n = np.zeros(3); r0 = rings[0]
    for i in range(len(r0)):
        a, b = r0[i], r0[(i+1) % len(r0)]
        n += [(a[1]-b[1])*(a[2]+b[2]), (a[2]-b[2])*(a[0]+b[0]), (a[0]-b[0])*(a[1]+b[1])]
    ln = np.linalg.norm(n)
    if ln < 1e-9: return
    n /= ln
    keep = [i for i in range(3) if i != np.argmax(np.abs(n))]
    try: t = earcut.triangulate_float64(allp[:, keep], np.cumsum([len(r) for r in rings]).astype(np.uint32))
    except Exception: return
    if len(t) == 0: return
    if roof:
        uv = np.stack([(allu[:, 0]-X0)/(X1-X0), (allu[:, 1]-Y0)/(Y1-Y0), np.zeros(len(allu))], 1)
    else:
        d = np.array([-n[1], n[0]]); dl = np.linalg.norm(d)
        d = d/dl if dl > 1e-6 else np.array([1.0, 0.0])
        pr = allp[:, :2] @ d; c = (pr.min()+pr.max())/2
        uv = np.stack([pr-c, allp[:, 2]-zbase, np.full(len(allp), (pr.max()-pr.min())/2)], 1)
    pos.append(allp); nrm.append(np.repeat(n[None], len(allp), 0)); uvs.append(uv)
    cls.append(np.full(len(allp), flags | (1 if roof else 0), np.uint8))
    bix.append(np.full(len(allp), bi, np.uint16))
    idx.append(np.asarray(t, np.uint32) + nv); nv += len(allp)

for f in sorted(glob.glob(CFG['gml_glob'])):
    print('lese', f, file=sys.stderr)
    for _, b in etree.iterparse(f, tag=B+'Building', huge_tree=True):
        bid = b.get(G+'id')
        grounds = [ring(g) for g in b.iterfind('.//bldg:GroundSurface//gml:exterior', NS)] if bid not in seen else []
        if not grounds:
            b.clear(); continue
        cg = np.concatenate(grounds)
        clon, clat = tr.transform(cg[:, 0].mean(), cg[:, 1].mean())
        if not (W <= clon <= E and S <= clat <= N):
            b.clear(); continue
        seen.add(bid); bi = len(feats); v0 = nv
        fn = b.findtext('bldg:function', namespaces=NS) or ''; code = fn.split('_')[-1]
        cat = {'1': 0, '2': 1, '3': 2}.get(code[:1], 3)
        mh = [float(x.text) for x in b.iterfind('.//bldg:measuredHeight', NS)]
        h = max(mh) if mh else None
        flags = cat << 1
        if code in NOWIN or (h is not None and h < 3.5): flags |= 8
        if code in GLASSY: flags |= 16
        zbase = float(cg[:, 2].min()) - H0
        for kind, roof in (('RoofSurface', True), ('WallSurface', False)):
            for poly in b.iterfind('.//bldg:%s//gml:Polygon' % kind, NS):
                ext = poly.find('gml:exterior', NS)
                if ext is None: continue
                add_polygon([ring(ext)] + [ring(i) for i in poly.iterfind('gml:interior', NS)], roof, flags, bi, zbase)
        _, glon, glat = local(cg)
        feats.append({'id': bid, 'f': fn, 'h': h, 'r': b.findtext('.//bldg:roofType', namespaces=NS),
                      'z': round(zbase, 2), 'c': [round(float(glon.mean()), 6), round(float(glat.mean()), 6)], 'v': [v0, nv]})
        b.clear()
        while b.getprevious() is not None: del b.getparent()[0]

P = np.concatenate(pos); I = np.concatenate(idx)
print('Gebäude', len(feats), 'Vertices', len(P), 'Dreiecke', len(I)//3, file=sys.stderr)
assert np.abs(P).max() < 3276
out = CFG['out']
with open(out+'/buildings.bin', 'wb') as fh:
    fh.write(np.round(P*10).astype(np.int16).tobytes())          # 6n
    fh.write(np.round(np.concatenate(nrm)*127).astype(np.int8).tobytes())  # 3n
    fh.write(np.concatenate(cls).tobytes())                      # 1n
    fh.write(np.concatenate(bix).tobytes())                      # 2n  -> 12n
    fh.write(np.concatenate(uvs).astype(np.float32).tobytes())   # 12n -> 24n
    fh.write(I.tobytes())
json.dump({'vertexCount': int(len(P)), 'indexCount': int(len(I)), 'buildings': feats},
          open(out+'/buildings.json', 'w'), separators=(',', ':'), ensure_ascii=False)
