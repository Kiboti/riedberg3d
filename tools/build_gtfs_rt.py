#!/usr/bin/env python3
"""Fahrplan-Auszug für den Echtzeit-Proxy (tools/serve.py).
Quelle: gtfs.de „Nahverkehr Deutschland“ (nv_free, CC BY 4.0), vorher mit riedberg-game/tools/gtfs_extract.py
auf das Riedberg-Umfeld beschnitten (/workspace/gtfs/sub). Ergebnis: data/gtfs_riedberg.json
"""
import json, sys
from pyproj import Transformer
SRC = sys.argv[1] if len(sys.argv) > 1 else '/workspace/gtfs/sub'
EC, NC, LIM = 474050, 5558450, 3300          # Spiel-Koordinaten-Ursprung (UTM 32N), Radius um das Modell
tr = Transformer.from_crs(25832, 4326, always_xy=True)
st = json.load(open(SRC + '/stop_times.json')); stops = json.load(open(SRC + '/stops.json')); meta = json.load(open(SRC + '/meta.json'))
def sec(t): h, m, s = map(int, t.split(':')); return h*3600 + m*60 + s
keep = {k: v for k, v in stops.items() if abs(v['x']) < LIM and abs(v['z']) < LIM}
out_stops = {}
for k, v in keep.items():
    lon, lat = tr.transform(v['x'] + EC, NC - v['z']); out_stops[k] = [round(lat, 6), round(lon, 6), v['name']]
trips = {}
for tid, rows in st.items():
    r = meta['trips'].get(tid)
    if not r: continue
    line, rtype = meta['routes'][r[0]][:2]
    rr = [[int(a[0]), a[1], sec(a[2]), sec(a[3])] for a in rows if a[1] in keep]
    if len(rr) < 2: continue
    trips[tid] = [line, int(rtype), rr, rows[-1][4] or '']
json.dump({'source': 'gtfs.de nv_free (CC BY 4.0), Auszug Riedberg', 'stops': out_stops, 'trips': trips},
          open('data/gtfs_riedberg.json', 'w'), separators=(',', ':'), ensure_ascii=False)
print(len(out_stops), 'Haltepunkte,', len(trips), 'Fahrten')
