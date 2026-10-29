// Echtzeit-Wetter: Bright Sky (DWD Open Data), Fallback Open-Meteo. Beide ohne API-Key.
const ICON_DE = { 'clear-day': 'Klar', 'clear-night': 'Klar', 'partly-cloudy-day': 'Teils bewölkt', 'partly-cloudy-night': 'Teils bewölkt',
  cloudy: 'Bewölkt', fog: 'Nebel', wind: 'Windig', rain: 'Regen', sleet: 'Schneeregen', snow: 'Schnee', hail: 'Hagel', thunderstorm: 'Gewitter' };
const EMOJI = { 'clear-day': '☀️', 'clear-night': '🌙', 'partly-cloudy-day': '⛅', 'partly-cloudy-night': '☁️', cloudy: '☁️', fog: '🌫️', wind: '💨',
  rain: '🌧️', sleet: '🌨️', snow: '❄️', hail: '🌨️', thunderstorm: '⛈️' };
const PRECIP = { rain: 'rain', sleet: 'rain', hail: 'rain', thunderstorm: 'rain', snow: 'snow' };
export function windDir(deg) { if (deg == null) return ''; return ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]; }
export async function fetchWeather(lat, lon) {
  try {
    const r = await fetch(`https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}`);
    if (!r.ok) throw new Error(r.status);
    const j = await r.json(), w = j.weather, st = j.sources?.find((s) => s.id === w.source_id);
    const cond = w.condition, icon = w.icon;
    return { src: 'Bright Sky / DWD', station: st ? `${st.station_name} (${(st.distance / 1000).toFixed(1).replace('.', ',')} km)` : '',
      time: new Date(w.timestamp), temp: w.temperature, icon, text: ICON_DE[icon] || cond, emoji: EMOJI[icon] || '',
      wind: w.wind_speed_10 ?? w.wind_speed_30, windDeg: w.wind_direction_10 ?? w.wind_direction_30, gust: w.wind_gust_speed_10,
      cloud: w.cloud_cover, vis: w.visibility, precip: w.precipitation_10 ?? w.precipitation_30, humidity: w.relative_humidity,
      precipType: PRECIP[cond] || (w.precipitation_10 > 0 ? 'rain' : null), fog: cond === 'fog', storm: cond === 'thunderstorm' };
  } catch (e) {
    console.warn('Bright Sky nicht erreichbar, nutze Open-Meteo', e);
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,precipitation,visibility,relative_humidity_2m&timezone=Europe%2FBerlin`);
    const c = (await r.json()).current, code = c.weather_code;
    const icon = code === 0 ? 'clear-day' : code <= 2 ? 'partly-cloudy-day' : code === 3 ? 'cloudy' : code <= 48 ? 'fog' : code <= 67 || (code >= 80 && code <= 82) ? 'rain' : code <= 77 || code === 85 || code === 86 ? 'snow' : 'thunderstorm';
    return { src: 'Open-Meteo', station: 'Modell', time: new Date(), temp: c.temperature_2m, icon, text: ICON_DE[icon], emoji: EMOJI[icon],
      wind: c.wind_speed_10m, windDeg: c.wind_direction_10m, cloud: c.cloud_cover, vis: c.visibility, precip: c.precipitation, humidity: c.relative_humidity_2m,
      precipType: PRECIP[icon] || null, fog: icon === 'fog', storm: icon === 'thunderstorm' };
  }
}
// Effekt-Vorschau (simuliert, nur zum Testen der Darstellung)
export const PRESETS = {
  klar: { cloud: 5, vis: 40000, precipType: null, fog: false, storm: false },
  bewoelkt: { cloud: 100, vis: 20000, precipType: null, fog: false, storm: false },
  regen: { cloud: 100, vis: 6000, precipType: 'rain', precip: 1.2, fog: false, storm: false },
  schnee: { cloud: 100, vis: 3000, precipType: 'snow', precip: 0.6, fog: false, storm: false },
  nebel: { cloud: 100, vis: 350, precipType: null, fog: true, storm: false },
  gewitter: { cloud: 100, vis: 5000, precipType: 'rain', precip: 3, fog: false, storm: true },
};
