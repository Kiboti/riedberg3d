"""Baumkataster Frankfurt (Grünflächenamt, Offene Daten Frankfurt, dl-de/by-2-0) -> data/trees.bin
Pro Baum float32: x, y, z (Gelände, lokal), Höhe (m), Kronendurchmesser (m), Typ (0 Laub, 1 Nadel), Gattungs-Index."""
import csv, json, math, sys
import numpy as np
from pyproj import Transformer
CFG = json.load(open(sys.argv[1]))
LON0, LAT0 = CFG['origin']; H0 = CFG['h0']; W, S, E, N = CFG['bbox']
R = 6378137.0; MLON = 2*math.pi*R/360*math.cos(math.radians(LAT0)); MLAT = 2*math.pi*R/360
meta = json.load(open(CFG['out']+'/terrain.json')); g = meta['grid']
H = np.fromfile(CFG['out']+'/height.bin', np.uint16).reshape(g['h'], g['w'])*g['scale']
tr = Transformer.from_crs(25832, 4326, always_xy=True)
CONIFER = {'Pinus', 'Picea', 'Abies', 'Taxus', 'Larix', 'Thuja', 'Pseudotsuga', 'Cedrus', 'Chamaecyparis', 'Juniperus', 'Metasequoia', 'Sequoiadendron', 'Tsuga', 'Cupressocyparis'}
def num(s):
    try: return float(s.replace(',', '.'))
    except Exception: return None
rows, genera, est = [], [], 0
for r in csv.DictReader(open(sys.argv[2], encoding='utf-8', errors='replace'), delimiter=';'):
    y, x = num(r['ETRS 89 Hochwert']), num(r['ETRS 89 Rechtswert'])
    if x is None or y is None: continue
    lon, lat = tr.transform(x, y)
    if not (W <= lon <= E and S <= lat <= N): continue
    gen = (r['Lateinischer Name'] or '?').split(' ')[0].strip(',')
    if gen not in genera: genera.append(gen)
    h, d = num(r['Baumhöhe']), num(r['Kronen Durchmesser in Meter'])
    if not d or d <= 0: d = None
    if not h or h <= 0:
        h = None
    if h is None or d is None: est += 1
    d = d or (h*0.6 if h else 4.0); h = h or max(3.0, d*1.4)   # nur Darstellungs-Ersatz, gezählt in 'estimated'
    fx = (lon-W)/(E-W)*(g['w']-1); fy = (N-lat)/(N-S)*(g['h']-1)
    z = float(H[int(round(fy)), int(round(fx))])
    rows.append([(lon-LON0)*MLON, (lat-LAT0)*MLAT, z, h, d, 1 if gen in CONIFER else 0, genera.index(gen)])
np.array(rows, np.float32).tofile(CFG['out']+'/trees.bin')
json.dump({'count': len(rows), 'estimated': est, 'genera': genera}, open(CFG['out']+'/trees.json', 'w'), ensure_ascii=False)
print(len(rows), 'Bäume,', est, 'mit fehlender Höhe/Krone (Ersatzmaß)', file=sys.stderr)
