// Riedberg 3D – Echtzeit-Verspätungen aus dem gtfs.de-GTFS-RT-Feed (SIRI Hessen, CC BY-SA 4.0) über den lokalen Proxy /api/rt (tools/serve.py).
// Zuordnung zu Transitous-Fahrtabschnitten heuristisch: gleiche Linie + planmäßige Zeit (±90 s) + Haltestelle (< 350 m).
const R = 6378137, RAD = Math.PI / 180;
const dist = (la1, lo1, la2, lo2) => Math.hypot((lo2 - lo1) * RAD * R * Math.cos(la1 * RAD), (la2 - la1) * RAD * R);
export class RT {
  constructor(enabled = true) { this.byLine = new Map(); this.ok = false; this.err = enabled ? null : 'nur bei lokalem Start mit tools/serve.py (Online-Version ohne Proxy)'; this.version = 0; this.n = 0; this.cancelled = 0; this.feedTs = null; }
  async poll() {
    try {
      const r = await fetch('api/rt', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'Proxy nicht aktiv (Seite mit tools/serve.py starten)' : 'HTTP ' + r.status);
      const j = await r.json(); if (!j.ok) throw new Error(j.error || 'Proxy-Fehler');
      const m = new Map();
      for (const t of j.trips) { if (!m.has(t.line)) m.set(t.line, []); m.get(t.line).push(t); }
      Object.assign(this, { byLine: m, ok: true, err: null, n: j.n, cancelled: j.trips.filter((t) => t.cancelled).length, feedTs: j.feedTimestamp });
      this.version++;
    } catch (e) { this.ok = false; this.err = e.message || String(e); }
  }
  // Halt k in Fahrt t mit planmäßiger Zeit (s) nahe sched und Lage nahe lat/lon; kind 3 = Abfahrt, 2 = Ankunft
  static at(t, lat, lon, sched, kind = 3, tol = 90, maxD = 350) {
    let best = -1, bd = 1e9;
    t.stops.forEach((s, k) => { const dt = Math.abs(s[kind] - sched); if (dt > tol) return; const d = dist(lat, lon, s[0], s[1]); if (d > maxD) return;
      const sc = dt + d / 10; if (sc < bd) { bd = sc; best = k; } });
    return best;
  }
  find(line, lat, lon, sched, kind = 3) {
    if (!this.ok || !line || lat == null) return null;
    let best = null, bd = 1e9;
    for (const t of this.byLine.get(line) || []) { const k = RT.at(t, lat, lon, sched, kind); if (k < 0) continue;
      const sc = Math.abs(t.stops[k][kind] - sched); if (sc < bd) { bd = sc; best = { trip: t, k }; } }
    return best;
  }
  // Zeiten eines Transitous-Abschnitts: gtfs.de-Echtzeit > Transitous-Echtzeit > Fahrplan
  segTimes(seg) {
    const sd = Date.parse(seg.scheduledDeparture) / 1000, sa = Date.parse(seg.scheduledArrival) / 1000, line = seg.trips?.[0]?.displayName;
    const a = this.find(line, seg.from?.lat, seg.from?.lon, sd, 3);
    const b = a ? RT.at(a.trip, seg.to.lat, seg.to.lon, sa, 2) : -1;
    if (a) {
      const st = a.trip.stops, dd = st[a.k][5] ?? st[a.k][4] ?? 0, da = b >= 0 ? (st[b][4] ?? st[b][5] ?? dd) : dd;
      return { t0: (sd + dd) * 1000, t1: (sa + da) * 1000, src: 'gtfs.de', delay: dd, delayTo: da, trip: a.trip,
        cancelled: a.trip.cancelled || (st[a.k][6] === 1 && (b < 0 || st[b][6] === 1)), skipped: st[a.k][6] === 1 };
    }
    if (seg.realTime) return { t0: Date.parse(seg.departure), t1: Date.parse(seg.arrival), src: 'Transitous', delay: (Date.parse(seg.departure) / 1000 - sd), delayTo: Date.parse(seg.arrival) / 1000 - sa };
    return { t0: sd * 1000, t1: sa * 1000, src: 'Fahrplan', delay: null, delayTo: null };
  }
}
export const fmtDelay = (s) => s == null ? '' : Math.round(s / 60) === 0 ? 'pünktlich' : (s > 0 ? '+' : '−') + Math.abs(Math.round(s / 60)) + ' min';
