// Sonnenstand nach den Formeln von SunCalc (V. Agafonkin, BSD-2) – Azimut ab Süd, westlich positiv.
const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;
export function sunPosition(date, lat, lng) {
  const d = date.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const M = rad * (357.5291 + 0.98560028 * d);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + rad * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const lw = rad * -lng, phi = rad * lat;
  const H = rad * (280.16 + 360.9856235 * d) - lw - ra;
  return {
    azimuth: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)),
    altitude: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)),
  };
}
// Zeit-Helfer für Europe/Berlin unabhängig von der Zeitzone des Browsers
const TZ = 'Europe/Berlin';
const fmtParts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function berlinParts(date) {
  const p = Object.fromEntries(fmtParts.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
}
export function berlinDate(y, m, d, minutes) {
  const want = Date.UTC(y, m - 1, d, 0, minutes); let t = want;
  for (let i = 0; i < 3; i++) { const p = berlinParts(new Date(t)); t += want - Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm); }
  return new Date(t);
}
