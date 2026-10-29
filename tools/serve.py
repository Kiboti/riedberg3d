#!/usr/bin/env python3
"""Riedberg 3D – lokaler Webserver mit Echtzeit-Proxy.

  python3 tools/serve.py [port]        (Standard 8080, dann http://localhost:8080 öffnen)

* liefert die statischen Dateien des Projektordners aus (wie `python -m http.server`)
* /api/rt  – Verspätungen/Ausfälle aus dem freien GTFS-Realtime-Feed von gtfs.de
  (https://realtime.gtfs.de/realtime-free.pb, Datenbasis SIRI Hessen/RMV, Lizenz CC BY-SA 4.0).
  Der Feed sendet keinen CORS-Header, darf also vom Browser nicht direkt gelesen werden – darum dieser Proxy.
  Er wird nur geladen, wenn die Seite offen ist (höchstens alle 60 s, gzip + If-Modified-Since,
  ca. 10 MB je Abruf), auf die Fahrten rund um den Riedberg gefiltert und als kleines JSON ausgegeben.
  Keine Zusatzpakete nötig (eigener Mini-Protobuf-Leser, nur Python-Standardbibliothek).
"""
import gzip, http.server, json, os, socketserver, sys, threading, time, urllib.request
from datetime import datetime, timedelta, timezone
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo('Europe/Berlin')
except Exception:                       # Windows ohne tzdata: feste Regel MEZ/MESZ
    TZ = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEED = 'https://realtime.gtfs.de/realtime-free.pb'
MIN_AGE = 60
PLAN = json.load(open(os.path.join(ROOT, 'data', 'gtfs_riedberg.json'), encoding='utf-8'))
TRIPS, STOPS = PLAN['trips'], PLAN['stops']

# ---------- Mini-Protobuf (nur die benötigten GTFS-RT-Felder) ----------
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i
def fields(b, i=0, end=None):
    end = len(b) if end is None else end
    while i < end:
        key, i = varint(b, i); f, wt = key >> 3, key & 7
        if wt == 0: v, i = varint(b, i); yield f, 0, v
        elif wt == 2:
            n, i = varint(b, i); yield f, 2, (i, i + n); i += n
        elif wt == 1: i += 8
        elif wt == 5: i += 4
        else: raise ValueError('wire type %d' % wt)
def sint(v): return v - (1 << 64) if v >= 1 << 63 else v
def event(b, a, e):
    d = t = None
    for f, wt, v in fields(b, a, e):
        if f == 1 and wt == 0: d = sint(v)
        elif f == 2 and wt == 0: t = sint(v)
    return d, t

def parse(b):
    """-> header timestamp, {trip_id: (start_date, cancelled, [(seq, stop_id, arr_d, arr_t, dep_d, dep_t, skipped)])}"""
    ts = 0; out = {}
    for f, wt, v in fields(b):
        if f == 1 and wt == 2:
            for g, w2, x in fields(b, *v):
                if g == 3 and w2 == 0: ts = x
        elif f == 2 and wt == 2:
            for g, w2, (a, e) in ((g, w2, x) for g, w2, x in fields(b, *v) if w2 == 2):
                if g != 3: continue                      # nur TripUpdate
                tid = None; sd = ''; rel = 0; stus = []; tu_delay = None
                for h, w3, y in fields(b, a, e):
                    if h == 1 and w3 == 2:
                        for k, w4, z in fields(b, *y):
                            if k == 1 and w4 == 2: tid = b[z[0]:z[1]].decode()
                            elif k == 3 and w4 == 2: sd = b[z[0]:z[1]].decode()
                            elif k == 4 and w4 == 0: rel = z
                        if tid not in TRIPS: break
                    elif h == 2 and w3 == 2: stus.append(y)
                    elif h == 5 and w3 == 0: tu_delay = sint(y)
                if tid not in TRIPS: continue
                ups = []
                for y in stus:
                    seq = sid = None; ad = at = dd = dt = None; skip = False
                    for k, w4, z in fields(b, *y):
                        if k == 1 and w4 == 0: seq = z
                        elif k == 2 and w4 == 2: ad, at = event(b, *z)
                        elif k == 3 and w4 == 2: dd, dt = event(b, *z)
                        elif k == 4 and w4 == 2: sid = b[z[0]:z[1]].decode()
                        elif k == 5 and w4 == 0: skip = z == 1
                    ups.append((seq, sid, ad, at, dd, dt, skip))
                if not ups and tu_delay is not None: ups.append((0, None, tu_delay, None, tu_delay, None, False))
                out[tid] = (sd, rel == 3, ups)
    return ts, out

# ---------- Zeit ----------
def berlin_offset(d):
    if TZ: return datetime(d.year, d.month, d.day, 12, tzinfo=TZ).utcoffset()
    def last_sun(m): x = datetime(d.year, m, 31); return x - timedelta(days=(x.weekday() + 1) % 7)
    return timedelta(hours=2 if last_sun(3) <= datetime(d.year, d.month, d.day) < last_sun(10) else 1)
def service_epoch(sd):
    """GTFS: Uhrzeiten zählen ab „Mittag minus 12 h“ des Betriebstags (Ortszeit)."""
    d = datetime.strptime(sd, '%Y%m%d')
    noon = datetime(d.year, d.month, d.day, 12, tzinfo=timezone(berlin_offset(d)))
    return int(noon.timestamp()) - 12 * 3600

# ---------- Feed-Cache ----------
LOCK = threading.Lock()
STATE = {'t': 0, 'lm': None, 'json': None, 'raw': None, 'err': None}
def fetch():
    req = urllib.request.Request(FEED, headers={'Accept-Encoding': 'gzip', 'User-Agent': 'Riedberg3D-private/1.0'})
    if STATE['lm']: req.add_header('If-Modified-Since', STATE['lm'])
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            data = r.read()
            if r.headers.get('Content-Encoding') == 'gzip': data = gzip.decompress(data)
            STATE['lm'] = r.headers.get('Last-Modified')
            return data
    except urllib.error.HTTPError as e:
        if e.code == 304: return None
        raise

def build(ts, rt):
    now = time.time(); trips = []
    for tid, (sd, canc, ups) in rt.items():
        line, rtype, rows, hs = TRIPS[tid]
        if not sd: continue
        base = service_epoch(sd)
        if base + rows[-1][2] < now - 3 * 3600 or base + rows[0][3] > now + 6 * 3600: continue
        ups = sorted((u for u in ups if u[0] is not None), key=lambda u: u[0])
        stops = []
        for seq, sid, arr, dep in rows:
            prev = [u for u in ups if u[0] <= seq]; u = prev[-1] if prev else (ups[0] if ups else None)
            da = dd = None; skip = False
            if u:
                exact = u[0] == seq
                if exact:
                    da = u[2] if u[2] is not None else (u[3] - (base + arr) if u[3] else None)
                    dd = u[4] if u[4] is not None else (u[5] - (base + dep) if u[5] else None)
                    skip = u[6]
                    if da is None: da = dd
                    if dd is None: dd = da
                else:   # Fortschreibung der letzten bekannten Verspätung
                    dd = u[4] if u[4] is not None else u[2]
                    if dd is None and u[5]: dd = u[5] - (base + [r for r in rows if r[0] == u[0]][0][3]) if any(r[0] == u[0] for r in rows) else None
                    da = dd
            s = STOPS[sid]
            stops.append([s[0], s[1], base + arr, base + dep, da, dd, 1 if skip else 0, s[2]])
        trips.append({'id': tid, 'line': line, 'type': rtype, 'hs': hs, 'cancelled': canc, 'stops': stops})
    return {'ok': True, 'source': 'gtfs.de GTFS-Realtime (SIRI Hessen), CC BY-SA 4.0', 'feedTimestamp': ts,
            'fetched': int(now), 'n': len(trips), 'trips': trips}

def rt_json():
    with LOCK:
        if STATE['json'] and time.time() - STATE['t'] < MIN_AGE: return STATE['json']
        try:
            data = fetch()
            if data is not None: STATE['raw'] = parse(data)
            if STATE['raw'] is None: raise RuntimeError('kein Feed')
            STATE['json'] = json.dumps(build(*STATE['raw']), ensure_ascii=False, separators=(',', ':')).encode()
            STATE['err'] = None
        except Exception as e:
            STATE['err'] = str(e)
            if not STATE['json']: return json.dumps({'ok': False, 'error': str(e)}).encode()
        STATE['t'] = time.time()
        return STATE['json']

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.json': 'application/json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm'}
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache'); super().end_headers()
    def log_message(self, fmt, *a):
        if '/api/' in (self.path or ''): sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a))
    def do_GET(self):
        if self.path.split('?')[0] == '/api/rt':
            body = rt_json()
            self.send_response(200); self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        super().do_GET()

class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True; allow_reuse_address = True

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print('Riedberg 3D läuft auf http://localhost:%d  (Beenden: Strg+C)' % port)
    S(('', port), H).serve_forever()
