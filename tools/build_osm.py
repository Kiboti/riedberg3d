"""OpenStreetMap (ODbL) -> Straßen, Gehwege, Bordsteine, Markierungen, Gleise als 3D-Netze auf dem DGM1-Gelände
+ Stadtmöbel (Laternen, Bänke, Ampeln, Wartehäuschen, Spielplätze, Papierkörbe).
Aufruf: python3 tools/build_osm.py tools/config.json   (lädt data/cache/osm_raw.json, holt es sonst einmalig per Overpass)
Ausgabe: data/streets.bin + data/streets.json (Netze), data/furniture.json (Objekte, lokale Koordinaten)."""
import json, math, os, sys, urllib.request, urllib.parse
from collections import defaultdict
import numpy as np
from pyproj import Transformer
import mapbox_earcut as earcut

CFG = json.load(open(sys.argv[1])); OUT = CFG['out']
LON0, LAT0 = CFG['origin']; H0 = CFG['h0']; W, S, E, N = CFG['bbox']
X0, Y0, X1, Y1 = CFG['utm_bbox']
R = 6378137.0; MLON = 2*math.pi*R/360*math.cos(math.radians(LAT0)); MLAT = 2*math.pi*R/360
RAW = OUT + '/cache/osm_raw.json'
QUERY = f"""[out:json][timeout:120];
( way["highway"]({S},{W},{N},{E}); way["railway"~"subway|light_rail|tram|rail"]({S},{W},{N},{E});
  node["highway"~"street_lamp|traffic_signals|bus_stop|crossing"]({S},{W},{N},{E});
  node["amenity"~"bench|waste_basket|bicycle_parking"]({S},{W},{N},{E}); node["public_transport"="platform"]({S},{W},{N},{E});
  node["shelter"="yes"]({S},{W},{N},{E}); nwr["leisure"="playground"]({S},{W},{N},{E}); way["area:highway"]({S},{W},{N},{E}); );
out body geom;"""
if not os.path.exists(RAW):
    os.makedirs(OUT + '/cache', exist_ok=True)
    req = urllib.request.Request('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': QUERY}).encode(),
                                 headers={'User-Agent': 'Riedberg3D-private/1.0'})
    open(RAW, 'wb').write(urllib.request.urlopen(req, timeout=180).read())
D = json.load(open(RAW)); EL = D['elements']
OSM_TS = D.get('osm3s', {}).get('timestamp_osm_base', '')

# ---------- Gelände: exakt das Dreiecksnetz aus terrain.bin (8-m-Raster, gleiche Triangulierung) ----------
tm = json.load(open(OUT + '/terrain.json'))
nV = tm['vertexCount']; P = np.fromfile(OUT + '/terrain.bin', np.float32, nV*3).reshape(-1, 3)
STEP = CFG.get('terrain_step', 8); nx = len(range(0, X1-X0+1, STEP)); ny = len(range(0, Y1-Y0+1, STEP))
ZG = P[:nx*ny, 2].reshape(ny, nx).astype(np.float64)
to_utm = Transformer.from_crs(4326, 25832, always_xy=True)
def ground(xy):
    xy = np.asarray(xy, np.float64).reshape(-1, 2)
    e, n = to_utm.transform(xy[:, 0]/MLON + LON0, xy[:, 1]/MLAT + LAT0)
    u = (np.asarray(e) - (X0 + 0.5))/STEP; v = ((Y1 - 0.5) - np.asarray(n))/STEP
    i = np.clip(np.floor(u).astype(int), 0, nx-2); j = np.clip(np.floor(v).astype(int), 0, ny-2)
    fu = np.clip(u - i, 0, 1); fv = np.clip(v - j, 0, 1)
    z00, z01, z10, z11 = ZG[j, i], ZG[j, i+1], ZG[j+1, i], ZG[j+1, i+1]
    lo = fu + fv <= 1
    return np.where(lo, z00 + fu*(z01-z00) + fv*(z10-z00), z11 + (1-fu)*(z10-z11) + (1-fv)*(z01-z11))
loc = lambda lon, lat: ((lon-LON0)*MLON, (lat-LAT0)*MLAT)

class Mesh:
    def __init__(s): s.p, s.uv, s.i = [], [], []
    def add(s, pts, uvs, tris):
        b = len(s.p); s.p += pts; s.uv += uvs; s.i += [b+t for t in tris]
MESH = defaultdict(Mesh)

def densify(pts, step=4.0):
    out, cum, nodeAt = [pts[0]], [0.0], [0.0]
    for a, b in zip(pts[:-1], pts[1:]):
        L = math.hypot(b[0]-a[0], b[1]-a[1]); k = max(1, int(math.ceil(L/step)))
        for t in range(1, k+1):
            out.append((a[0]+(b[0]-a[0])*t/k, a[1]+(b[1]-a[1])*t/k)); cum.append(cum[-1] + L/k)
        nodeAt.append(cum[-1])
    return np.array(out), np.array(cum), nodeAt
def normals(pts):
    d = np.zeros_like(pts); d[1:-1] = pts[2:] - pts[:-2]; d[0] = pts[1] - pts[0]; d[-1] = pts[-1] - pts[-2]
    d /= np.linalg.norm(d, axis=1, keepdims=True) + 1e-9
    seg = pts[1:] - pts[:-1]; seg /= np.linalg.norm(seg, axis=1, keepdims=True) + 1e-9
    mit = np.ones(len(pts))
    if len(pts) > 2: mit[1:-1] = 1/np.clip(np.sum(seg[:-1]*seg[1:], 1)*0.5 + 0.5, 0.25, 1)**0.5
    return np.stack([-d[:, 1], d[:, 0]], 1), d, np.minimum(mit, 2.0)

def heights(xy, zoff, bridge, cum):
    if bridge is not None:   # Brücke: linear zwischen den Widerlagern (keine Brückenhöhen in OSM)
        za, zb = bridge; t = cum/max(cum[-1], 1e-6); return za + (zb-za)*t + zoff
    return ground(xy) + zoff

def ribbon(mesh, pts, cum, offs, zoff, bridge=None, worlduv=True, mask=None, face=None):
    """Band entlang der Mittellinie; offs = Querpositionen (links negativ). face=(side, z_unten) erzeugt zusätzlich senkrechte Kante."""
    nrm, tan, mit = normals(pts); n = len(pts)
    cols = []
    for o in offs:
        xy = pts + nrm*(o*mit)[:, None]
        z = heights(xy, zoff, None if bridge is None else bridge, cum) if bridge is not None else ground(xy) + zoff
        cols.append((xy, z))
    keep = np.ones(n-1, bool) if mask is None else (mask[:-1] & mask[1:])
    m = len(offs); pv = []; uv = []
    for k in range(n):
        for c in range(m):
            xy, z = cols[c]; pv.append((float(xy[k, 0]), float(xy[k, 1]), float(z[k])))
            uv.append((float(xy[k, 0]), float(xy[k, 1])) if worlduv else (float(offs[c]), float(cum[k])))
    tris = []
    for k in range(n-1):
        if not keep[k]: continue
        for c in range(m-1):
            a, b = k*m + c, k*m + c + 1; a2, b2 = a + m, b + m
            tris += [a, a2, b, b, a2, b2]
    if tris: mesh.add(pv, uv, tris)
    for fc in ([] if face is None else face if isinstance(face, list) else [face]):   # senkrechte Kante an Querposition offs[col] bis z_unten
        col, zlow = fc; xy, z = cols[col]; pv = []; uv = []; tris = []
        flip = col == 0
        for k in range(n):
            pv += [(float(xy[k, 0]), float(xy[k, 1]), float(z[k])), (float(xy[k, 0]), float(xy[k, 1]), float(z[k] - zoff + zlow))]
            uv += [(float(cum[k]), 0.0), (float(cum[k]), zoff - zlow)]
        for k in range(n-1):
            if keep[k]: tris += [2*k, 2*k+2, 2*k+1, 2*k+2, 2*k+3, 2*k+1] if flip else [2*k, 2*k+1, 2*k+2, 2*k+2, 2*k+1, 2*k+3]
        if tris: mesh.add(pv, uv, tris)

def quad(mesh, cx, cy, t, nrm, along, across, z):
    """flaches Rechteck (Markierung) zentriert bei (cx, cy), Länge along in Richtung t, Breite across."""
    pts = []
    for sa, sc in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
        pts.append((cx + t[0]*along/2*sa + nrm[0]*across/2*sc, cy + t[1]*along/2*sa + nrm[1]*across/2*sc))
    zz = ground(pts) + z
    mesh.add([(p[0], p[1], float(h)) for p, h in zip(pts, zz)], [(0.0, 0.0)]*4, [0, 2, 1, 1, 2, 3])

def poly_fill(mesh, ring, zoff, maxlen=8.0):
    """Polygon triangulieren (earcut) und fein unterteilen, damit es dem Gelände folgt."""
    arr = np.array(ring[:-1] if ring[0] == ring[-1] else ring, np.float64)
    if len(arr) < 3: return
    tri = earcut.triangulate_float64(arr, np.array([len(arr)], np.uint32)).reshape(-1, 3)
    out = []
    def sub(a, b, c, d=0):
        L = max(math.dist(a, b), math.dist(b, c), math.dist(c, a))
        if L <= maxlen or d > 7: out.append((a, b, c)); return
        ab = ((a[0]+b[0])/2, (a[1]+b[1])/2); bc = ((b[0]+c[0])/2, (b[1]+c[1])/2); ca = ((c[0]+a[0])/2, (c[1]+a[1])/2)
        for t in ((a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)): sub(*t, d+1)
    for t in tri: sub(*(tuple(arr[k]) for k in t))
    pts = [p for t in out for p in t]; zz = ground(pts) + zoff
    # Orientierung nach oben (gegen den Uhrzeigersinn)
    tris = []
    for k in range(len(out)):
        (ax, ay), (bx, by), (cx, cy) = out[k]
        tris += [3*k, 3*k+1, 3*k+2] if (bx-ax)*(cy-ay) - (by-ay)*(cx-ax) > 0 else [3*k, 3*k+2, 3*k+1]
    mesh.add([(p[0], p[1], float(h)) for p, h in zip(pts, zz)], [(p[0], p[1]) for p in pts], tris)

# ---------- Straßenklassen ----------
ROAD = {  # Breite (m), Höhenversatz, Bordstein
    'motorway': (8.0, 0.16, False), 'motorway_link': (4.5, 0.155, False), 'trunk': (7.5, 0.155, False), 'trunk_link': (4.5, 0.15, False),
    'primary': (7.5, 0.15, True), 'primary_link': (4.5, 0.145, True), 'secondary': (7.0, 0.145, True), 'secondary_link': (4.5, 0.14, True),
    'tertiary': (6.5, 0.14, True), 'tertiary_link': (4.5, 0.135, True), 'unclassified': (5.5, 0.13, True), 'residential': (5.5, 0.13, True),
    'living_street': (4.5, 0.125, False), 'service': (3.5, 0.11, False), 'track': (2.5, 0.10, False), 'pedestrian': (4.0, 0.115, False),
    'footway': (2.0, 0.09, False), 'path': (1.6, 0.085, False), 'cycleway': (2.0, 0.095, False), 'steps': (2.0, 0.09, False),
    'bridleway': (2.0, 0.08, False), 'platform': (3.0, 0.30, False), 'busway': (3.5, 0.13, False), 'road': (5.0, 0.12, False),
}
MAIN = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}
LIT_ROADS = {'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'primary_link', 'secondary_link', 'tertiary_link', 'pedestrian'}
UNPAVED = {'gravel', 'fine_gravel', 'compacted', 'unpaved', 'pebblestone', 'woodchips', 'rock'}
SOFT = {'dirt', 'ground', 'grass', 'earth', 'mud', 'sand', 'grass_paver'}
PAVERS = {'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone', 'concrete:plates', 'bricks'}
def fnum(s):
    try: return float(str(s).split()[0].replace(',', '.'))
    except Exception: return None

ways = [e for e in EL if e['type'] == 'way' and 'geometry' in e]
nodes = [e for e in EL if e['type'] == 'node']
road_ways = [w for w in ways if w['tags'].get('highway') in ROAD]
node_use = defaultdict(int)
for w in road_ways:
    if w['tags'].get('highway') in ('footway', 'path', 'cycleway', 'steps', 'bridleway', 'platform'): continue
    for nd in set(w['nodes']): node_use[nd] += 1
stats = defaultdict(float)
roadsegs = []   # für Nachbarschaftssuche (Laternen, Bänke, Haltestellen): (ax, ay, bx, by, breite, klasse, oneway)

for w in road_ways:
    t = w['tags']; hw = t['highway']
    if t.get('tunnel') in ('yes', 'building_passage', 'culvert') or t.get('covered') == 'yes' or t.get('indoor') == 'yes': continue
    if hw == 'platform' and t.get('area') != 'yes': pass
    pts0 = [loc(g['lon'], g['lat']) for g in w['geometry']]
    if len(pts0) < 2: continue
    width, zoff, curb = ROAD[hw]
    if hw == 'service' and t.get('service') in ('driveway', 'parking_aisle', 'drive-through'): width = 3.0
    lanes = fnum(t.get('lanes'))
    if lanes and hw in MAIN: width = max(width, lanes*3.25 + (0.5 if hw.startswith('motorway') else 0))
    tw = fnum(t.get('width'))
    if tw and 1.0 <= tw <= 25: width = tw
    surf = t.get('surface', '')
    if surf in SOFT: continue
    if hw in ('footway', 'path', 'steps', 'pedestrian', 'platform', 'bridleway'):
        mat = 'asphalt' if surf == 'asphalt' else 'gravel' if surf in UNPAVED else 'paving'
        if hw in ('path', 'bridleway') and not surf: continue   # Pfade ohne Belag: Luftbild zeigt sie bereits
    elif hw == 'track':
        mat = 'asphalt' if surf in ('asphalt', 'concrete') else 'gravel'
        if t.get('tracktype') in ('grade3', 'grade4', 'grade5'): continue
    elif hw == 'cycleway': mat = 'gravel' if surf in UNPAVED else 'paving' if surf in PAVERS else 'asphalt'
    else: mat = 'gravel' if surf in UNPAVED else 'paving' if surf in PAVERS else 'asphalt'
    is_area = t.get('area') == 'yes' and w['nodes'][0] == w['nodes'][-1]
    if is_area:
        poly_fill(MESH[mat], pts0, zoff); stats['area_' + mat] += 1; continue
    pts, cum, nodeAt = densify(pts0)
    bridge = None
    if t.get('bridge') in ('yes', 'viaduct', 'boardwalk'):
        zz = ground([pts[0], pts[-1]]); bridge = (float(zz[0]), float(zz[1]))
    offs = [-width/2, 0.0, width/2] if width > 6 else [-width/2, width/2]
    ribbon(MESH[mat], pts, cum, offs, zoff, bridge)
    stats['km_' + mat] += cum[-1]/1000
    if hw in ROAD and hw not in ('footway', 'path', 'cycleway', 'steps', 'bridleway', 'platform'):
        for a, b in zip(pts0[:-1], pts0[1:]): roadsegs.append((a[0], a[1], b[0], b[1], width, hw, t.get('oneway') in ('yes', '1', '-1') or hw.startswith('motorway')))
    if bridge is not None: continue
    # Kreuzungsbereiche für Bordsteine/Markierungen aussparen
    junc = [nodeAt[k] for k, nd in enumerate(w['nodes']) if node_use[nd] > 1]
    def free(r):
        if not junc: return np.ones(len(cum), bool)
        dmin = np.min(np.abs(cum[:, None] - np.array(junc)[None, :]), 1); return dmin > r
    oneway = t.get('oneway') in ('yes', '1', '-1') or hw.startswith('motorway')
    # Bordsteine + Gehwege
    if curb and mat == 'asphalt':
        sw = t.get('sidewalk', t.get('sidewalk:both', ''))
        sides = {'both': (-1, 1), 'left': (-1,), 'right': (1,), 'yes': (-1, 1)}.get(sw, ())
        if t.get('sidewalk:left') == 'yes': sides = tuple(set(sides) | {-1})
        if t.get('sidewalk:right') == 'yes': sides = tuple(set(sides) | {1})
        mk = free(width/2 + 6)
        for sd in (-1, 1):
            o0 = sd*width/2; o1 = sd*(width/2 + 0.15)
            ribbon(MESH['curb'], pts, cum, sorted([o0, o1]), 0.27, mask=mk, worlduv=False, face=(1 if sd < 0 else 0, zoff))   # Kante zur Fahrbahn
            stats['km_curb'] += cum[-1]/1000*mk.mean()
            if sd in sides:
                p0 = sd*(width/2 + 0.15); p1 = sd*(width/2 + 2.15)
                ribbon(MESH['paving'], pts, cum, sorted([p0, p1]), 0.25, mask=mk, face=(1 if sd < 0 else 0, -0.05) if False else None)
                stats['km_sidewalk'] += cum[-1]/1000*mk.mean()
    # Fahrbahnmarkierungen
    mz = zoff + 0.02
    nrm, tan, _ = normals(pts); okc = free(width/2 + 4)
    def dashes(off, dash, gap, wid):
        if cum[-1] < 4: return
        s = 2.0
        while s + dash < cum[-1] - 2:
            m = s + dash/2; k = int(np.searchsorted(cum, m)); k = min(max(k, 1), len(cum)-1)
            if okc[k] and okc[k-1]:
                f = (m - cum[k-1])/max(cum[k]-cum[k-1], 1e-6); c = pts[k-1] + (pts[k]-pts[k-1])*f; tt = tan[k]; nn = nrm[k]
                quad(MESH['marking'], c[0] + nn[0]*off, c[1] + nn[1]*off, tt, nn, dash, wid, mz); stats['marks'] += 1
            s += dash + gap
    def solid(off, wid):
        mk = okc.copy(); ribbon(MESH['marking'], pts, cum, [off - wid/2, off + wid/2], mz, mask=mk, worlduv=False); stats['km_solid'] += cum[-1]/1000
    if mat == 'asphalt':
        if hw.startswith('motorway') or hw.startswith('trunk'):
            solid(-width/2 + 0.45, 0.25); solid(width/2 - 0.45, 0.15)
            nl = int(lanes or (2 if hw in ('motorway', 'trunk') else 1))
            lw = (width - 0.9)/max(nl, 1)
            for k in range(1, nl): dashes(-width/2 + 0.45 + k*lw, 6, 12, 0.15)
        elif hw in ('primary', 'secondary', 'tertiary', 'primary_link', 'secondary_link') or (lanes and lanes >= 2 and hw in ('unclassified', 'residential')):
            if not oneway: dashes(0.0, 3, 6, 0.12)
            elif lanes and lanes >= 2:
                for k in range(1, int(lanes)): dashes(-width/2 + k*width/lanes, 3, 6, 0.12)
            if hw in ('primary', 'secondary'): solid(-width/2 + 0.3, 0.12); solid(width/2 - 0.3, 0.12)

# ---------- Gleise (U-Bahn/Stadtbahn) ----------
for w in ways:
    t = w['tags']; rw = t.get('railway')
    if rw not in ('subway', 'light_rail', 'tram', 'rail') or t.get('tunnel') in ('yes',) or t.get('covered') == 'yes': continue
    if t.get('service') in ('yard', 'siding') and rw == 'rail': pass
    pts0 = [loc(g['lon'], g['lat']) for g in w['geometry']]
    if len(pts0) < 2: continue
    pts, cum, _ = densify(pts0, 4.0)
    bridge = None
    if t.get('bridge') in ('yes', 'viaduct'):
        zz = ground([pts[0], pts[-1]]); bridge = (float(zz[0]), float(zz[1]))
    embedded = t.get('embedded') == 'yes' or rw == 'tram'
    if not embedded: ribbon(MESH['gravel'], pts, cum, [-1.6, 0.0, 1.6], 0.18, bridge)
    base = 0.13 if embedded else 0.18
    for g in (-0.7175, 0.7175):
        ribbon(MESH['rail'], pts, cum, [g - 0.035, g + 0.035], base + 0.24, bridge, worlduv=False, face=[(0, base + 0.06), (1, base + 0.06)])
    if not embedded:   # Schwellen: Band mit Streifentextur (Abstand 0,65 m) statt Einzelgeometrie
        ribbon(MESH['sleeper'], pts, cum, [-1.3, 1.3], base + 0.08, bridge, worlduv=False)
    stats['km_track'] += cum[-1]/1000

# ---------- Stadtmöbel ----------
RS = np.array([s[:5] for s in roadsegs]) if roadsegs else np.zeros((0, 5))
RCLS = [s[5] for s in roadsegs]; RONE = [s[6] for s in roadsegs]
def nearest_road(x, y, classes=None):
    a = RS[:, 0:2]; b = RS[:, 2:4]; ab = b - a; L2 = np.sum(ab*ab, 1) + 1e-9
    tt = np.clip(np.sum((np.array([x, y]) - a)*ab, 1)/L2, 0, 1); pr = a + ab*tt[:, None]
    d = np.hypot(pr[:, 0] - x, pr[:, 1] - y)
    if classes: d = np.where([c in classes for c in RCLS], d, 1e9)
    k = int(np.argmin(d)); tv = ab[k]/math.sqrt(L2[k])
    return k, float(d[k]), pr[k], tv
inside = lambda x, y: -1800 < x < 1800 and -1800 < y < 1800
FUR = defaultdict(list)
def z_at(x, y): return round(float(ground([(x, y)])[0]), 2)
# Laternen aus OSM
lamps = []
for nd in nodes:
    t = nd.get('tags', {})
    if t.get('highway') != 'street_lamp': continue
    x, y = loc(nd['lon'], nd['lat'])
    k, d, pr, tv = nearest_road(x, y)
    ang = math.atan2(pr[1] - y, pr[0] - x) if d > 0.3 else math.atan2(tv[1], tv[0]) + math.pi/2
    h = fnum(t.get('lamp_mount_height') or t.get('height')) or (8.0 if RCLS[k] in MAIN and d < 15 else 5.5)
    lamps.append([round(x, 2), round(y, 2), z_at(x, y), round(min(max(h, 3.5), 12), 1), round(ang, 3), 1])
n_osm_lamps = len(lamps)
# Ergänzung entlang beleuchtbarer Straßen (Annahme: üblicher Abstand 30-35 m, einseitig), nur wo im Umkreis keine Laterne kartiert ist
grid = defaultdict(list)
def gkey(x, y): return (int(x//25), int(y//25))
for L in lamps: grid[gkey(L[0], L[1])].append(L)
def near_lamp(x, y, r):
    gx, gy = gkey(x, y)
    for i in range(gx-1, gx+2):
        for j in range(gy-1, gy+2):
            for L in grid[(i, j)]:
                if (L[0]-x)**2 + (L[1]-y)**2 < r*r: return True
    return False
for w in road_ways:
    t = w['tags']; hw = t['highway']
    if hw not in LIT_ROADS or t.get('lit') == 'no' or t.get('tunnel') == 'yes': continue
    pts0 = [loc(g['lon'], g['lat']) for g in w['geometry']]
    if len(pts0) < 2: continue
    width = ROAD[hw][0]; spacing = 34.0 if hw in MAIN else 30.0
    pts, cum, _ = densify(pts0, 1.0); nrm, tan, _ = normals(pts)
    s = spacing*0.5
    while s < cum[-1]:
        k = min(int(np.searchsorted(cum, s)), len(cum)-1); side = 1 if (w['id'] % 2) else -1
        off = width/2 + (2.6 if ROAD[hw][2] else 1.0)
        x = pts[k, 0] + nrm[k, 0]*off*side; y = pts[k, 1] + nrm[k, 1]*off*side
        if inside(x, y) and not near_lamp(x, y, spacing*0.6):
            L = [round(float(x), 2), round(float(y), 2), z_at(x, y), 8.0 if hw in MAIN else 5.5, round(math.atan2(-nrm[k, 1]*side, -nrm[k, 0]*side), 3), 0]
            lamps.append(L); grid[gkey(x, y)].append(L)
        s += spacing
FUR['lamps'] = lamps
# Bänke, Papierkörbe
allsegs = []
for w in ways:
    if 'highway' in w['tags']:
        g = [loc(p['lon'], p['lat']) for p in w['geometry']]; allsegs += [(a[0], a[1], b[0], b[1]) for a, b in zip(g[:-1], g[1:])]
AS = np.array(allsegs)
def nearest_any(x, y):
    a = AS[:, 0:2]; b = AS[:, 2:4]; ab = b - a; L2 = np.sum(ab*ab, 1) + 1e-9
    tt = np.clip(np.sum((np.array([x, y]) - a)*ab, 1)/L2, 0, 1); pr = a + ab*tt[:, None]
    d = np.hypot(pr[:, 0] - x, pr[:, 1] - y); k = int(np.argmin(d)); return float(d[k]), pr[k], ab[k]/math.sqrt(L2[k])
for nd in nodes:
    t = nd.get('tags', {}); x, y = loc(nd['lon'], nd['lat'])
    if not inside(x, y): continue
    if t.get('amenity') == 'bench':
        d, pr, tv = nearest_any(x, y)
        ang = math.atan2(pr[1] - y, pr[0] - x) if d > 0.2 else math.atan2(tv[1], tv[0]) + math.pi/2   # Sitzfläche schaut zum Weg
        FUR['benches'].append([round(x, 2), round(y, 2), z_at(x, y), round(ang, 3)])
    elif t.get('amenity') == 'waste_basket':
        FUR['baskets'].append([round(x, 2), round(y, 2), z_at(x, y)])
# Ampeln: am Fahrbahnrand der zugehörigen Straße, bei Gegenverkehr beidseitig
way_of = defaultdict(list)
for w in road_ways:
    for i, nd in enumerate(w['nodes']): way_of[nd].append((w, i))
for nd in nodes:
    t = nd.get('tags', {})
    sig = t.get('highway') == 'traffic_signals' or (t.get('highway') == 'crossing' and t.get('crossing') == 'traffic_signals')
    if not sig: continue
    x, y = loc(nd['lon'], nd['lat'])
    if not inside(x, y): continue
    cand = [(w, i) for w, i in way_of.get(nd['id'], []) if w['tags']['highway'] in ROAD and w['tags']['highway'] not in ('footway', 'path', 'cycleway', 'steps')]
    if cand:
        w, i = max(cand, key=lambda c: ROAD[c[0]['tags']['highway']][0]); g = w['geometry']
        a = g[max(i-1, 0)]; b = g[min(i+1, len(g)-1)]; ax, ay = loc(a['lon'], a['lat']); bx, by = loc(b['lon'], b['lat'])
        tv = np.array([bx-ax, by-ay]); tv /= np.linalg.norm(tv) + 1e-9; width = ROAD[w['tags']['highway']][0]
        lanes = fnum(w['tags'].get('lanes'))
        if lanes and w['tags']['highway'] in MAIN: width = max(width, lanes*3.25)
        one = w['tags'].get('oneway') in ('yes', '1') or w['tags']['highway'].startswith('motorway')
    else:
        k, d, pr, tv = nearest_road(x, y); width = RS[k, 4]; one = RONE[k]
    nv = np.array([-tv[1], tv[0]])
    for sd in ((1,) if one else (1, -1)):
        px = x + nv[0]*(width/2 + 0.6)*(-sd); py = y + nv[1]*(width/2 + 0.6)*(-sd)
        FUR['signals'].append([round(float(px), 2), round(float(py), 2), z_at(px, py), round(math.atan2(tv[1]*sd, tv[0]*sd) + math.pi, 3), 1 if t.get('highway') == 'crossing' else 0])
# Haltestellen: Wartehäuschen (shelter=yes) bzw. Haltestellenmast
seen = []
for nd in nodes:
    t = nd.get('tags', {})
    if not (t.get('highway') == 'bus_stop' or (t.get('public_transport') == 'platform' and t.get('bus') == 'yes')): continue
    x, y = loc(nd['lon'], nd['lat'])
    if not inside(x, y) or any((x-a)**2 + (y-b)**2 < 64 for a, b, _ in seen): continue
    shelter = t.get('shelter') == 'yes'; seen.append((x, y, shelter))
    k, d, pr, tv = nearest_road(x, y); width = RS[k, 4]
    nv = np.array([x - pr[0], y - pr[1]]); nv = nv/np.linalg.norm(nv) if d > 0.3 else np.array([-tv[1], tv[0]])
    edge = max(d, width/2 + 0.8)
    sx, sy = pr[0] + nv[0]*edge, pr[1] + nv[1]*edge
    ang = math.atan2(-nv[1], -nv[0])   # Öffnung zur Straße
    FUR['stopsigns'].append([round(float(sx), 2), round(float(sy), 2), z_at(sx, sy), round(ang, 3)])
    if shelter:
        hx, hy = pr[0] + nv[0]*(edge + 1.6), pr[1] + nv[1]*(edge + 1.6)
        FUR['shelters'].append([round(float(hx), 2), round(float(hy), 2), z_at(hx, hy), round(ang, 3)])
# Spielplätze: Fläche (Fallschutz/Sand) + Spielgeräte-Symbole am Mittelpunkt
for e in EL:
    t = e.get('tags', {})
    if t.get('leisure') != 'playground': continue
    if e['type'] == 'way' and 'geometry' in e:
        ring = [loc(g['lon'], g['lat']) for g in e['geometry']]
        if len(ring) >= 4 and e['nodes'][0] == e['nodes'][-1]:
            poly_fill(MESH['playground'], ring, 0.06)
            arr = np.array(ring); cx, cy = arr[:-1].mean(0)
            span = float(np.max(np.ptp(arr, 0)))
        else: continue
    elif e['type'] == 'node': cx, cy = loc(e['lon'], e['lat']); span = 10
    else: continue
    if inside(cx, cy): FUR['playgrounds'].append([round(float(cx), 2), round(float(cy), 2), z_at(cx, cy), round(min(span, 40), 1)])
# Zebrastreifen / Furten an Querungen
for nd in nodes:
    t = nd.get('tags', {})
    if t.get('highway') != 'crossing': continue
    kind = 'zebra' if (t.get('crossing') == 'zebra' or t.get('crossing_ref') == 'zebra' or t.get('crossing:markings') == 'zebra') else \
           'furt' if t.get('crossing') in ('traffic_signals', 'marked') or t.get('crossing:markings') in ('yes', 'dashes', 'lines') else None
    if not kind: continue
    cand = [(w, i) for w, i in way_of.get(nd['id'], []) if w['tags']['highway'] not in ('footway', 'path', 'cycleway', 'steps', 'platform', 'bridleway')]
    if not cand: continue
    w, i = cand[0]; g = w['geometry']; a = g[max(i-1, 0)]; b = g[min(i+1, len(g)-1)]
    ax, ay = loc(a['lon'], a['lat']); bx, by = loc(b['lon'], b['lat']); tv = np.array([bx-ax, by-ay]); tv /= np.linalg.norm(tv) + 1e-9
    nv = np.array([-tv[1], tv[0]]); hw = w['tags']['highway']; width = ROAD.get(hw, (5, 0.13, 0))[0]; zoff = ROAD.get(hw, (5, 0.13, 0))[1] + 0.025
    x, y = loc(nd['lon'], nd['lat'])
    if kind == 'zebra':
        o = -width/2 + 0.5
        while o < width/2 - 0.3:
            quad(MESH['marking'], x + nv[0]*o, y + nv[1]*o, tv, nv, 4.0, 0.5, zoff); o += 1.0
    else:
        for sa in (-2.0, 2.0):
            o = -width/2 + 0.25
            while o < width/2:
                quad(MESH['marking'], x + tv[0]*sa + nv[0]*o, y + tv[1]*sa + nv[1]*o, tv, nv, 0.12, 0.5, zoff); o += 1.0
    stats[kind] += 1

# ---------- Ausgabe: Int16-Positionen (x,y 6 cm, z 5 mm), Uint16-Indizes in Blöcken <= 65535 Ecken ----------
QXY, QZ = 0.06, 0.005
meta = {'meshes': {}, 'q': [QXY, QXY, QZ], 'osm_timestamp': OSM_TS, 'stats': {k: round(float(v), 2) for k, v in stats.items()}}
with open(OUT + '/streets.bin', 'wb') as fh:
    off = 0
    for name, m in MESH.items():
        if not m.i: continue
        p = np.array(m.p, np.float64); uv = np.array(m.uv, np.float32); idx = np.array(m.i, np.int64).reshape(-1, 3)
        chunks = []; t0 = 0; nt = len(idx)
        while t0 < nt:   # Dreiecke sind in Erzeugungsreihenfolge -> zusammenhängende Eckbereiche
            lo = idx[t0].min(); t1 = t0
            while t1 < nt and idx[t1].max() - lo < 65535 and idx[t1].min() >= lo: t1 += 1
            if t1 == t0: t1 = t0 + 1
            sel = idx[t0:t1]; vmin = int(sel.min()); vmax = int(sel.max())
            q = np.round(p[vmin:vmax+1] / np.array([QXY, QXY, QZ])).astype(np.int16)
            ii = (sel - vmin).astype(np.uint16).ravel()
            c = {'v': vmax - vmin + 1, 'i': len(ii), 'off': off}
            fh.write(q.tobytes()); off += q.nbytes
            if name == 'sleeper':
                u = uv[vmin:vmax+1, 1].astype(np.float32); fh.write(u.tobytes()); off += u.nbytes
            if off % 4: fh.write(b'\0' * (4 - off % 4)); off += 4 - off % 4
            fh.write(ii.tobytes()); off += ii.nbytes
            if off % 4: fh.write(b'\0' * (4 - off % 4)); off += 4 - off % 4
            chunks.append(c); t0 = t1
        meta['meshes'][name] = chunks
json.dump(meta, open(OUT + '/streets.json', 'w'))
FUR_META = {'osm_timestamp': OSM_TS, 'lamps_osm': n_osm_lamps, 'lamps_added': len(lamps) - n_osm_lamps,
            'fields': {'lamps': 'x,y,z,hoehe,richtung,osm(1)/ergaenzt(0)', 'benches': 'x,y,z,richtung', 'signals': 'x,y,z,richtung,fussgaenger',
                       'stopsigns': 'x,y,z,richtung', 'shelters': 'x,y,z,richtung', 'playgrounds': 'x,y,z,ausdehnung', 'baskets': 'x,y,z'}}
FUR_META.update(FUR)
json.dump(FUR_META, open(OUT + '/furniture.json', 'w'), separators=(',', ':'))
print('Netze:', {k: sum(c['v'] for c in v) for k, v in meta['meshes'].items()}, file=sys.stderr)
print('Statistik:', meta['stats'], file=sys.stderr)
print('Möbel:', {k: len(v) for k, v in FUR.items()}, 'Laternen OSM', n_osm_lamps, 'ergänzt', len(lamps) - n_osm_lamps, file=sys.stderr)
