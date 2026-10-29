// Riedberg 3D – Prototyp. Alle Daten offen (HVBG, OSM, Transitous/DELFI, gtfs.de, ambientCG). Keine API-Keys.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sunPosition, berlinParts, berlinDate } from './sun.js';
import { fetchWeather, windDir, PRESETS } from './weather.js';
import { QUALITY, initialQuality, saveQuality, Post, makeSky, LAMP, withLampLight } from './gfx.js';
import { loadStreets, loadFurniture } from './streets.js';
import { RT, fmtDelay } from './rt.js';

const API = 'https://api.transitous.org/api';
const BBOX = { w: 8.612, s: 50.162, e: 8.662, n: 50.194 };
// Statischer Betrieb (z. B. GitHub Pages): kein lokaler Proxy -> gtfs.de-Abfrage gar nicht erst versuchen (keine 404 in der Konsole),
// Transitous schonender abfragen (60 s). Lokal mit tools/serve.py: 30 s und gtfs.de-Verspätungen. Erzwingen: ?rt=1 bzw. ?rt=0
const RT_PARAM = new URLSearchParams(location.search).get('rt');
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(location.hostname) || location.protocol === 'file:';
const RT_PROXY = RT_PARAM ? RT_PARAM === '1' : LOCAL;
const POLL_MS = RT_PROXY ? 30000 : 60000;
const $ = (id) => document.getElementById(id);
const status = (t) => { $('load-status').textContent = t; };

// ---------- Szene ----------
const view = $('view');
let QN = initialQuality(), Q = QUALITY[QN];
const renderer = new THREE.WebGLRenderer({ antialias: !Q.composer, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.pr));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
view.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: 0, left: 0, pointerEvents: 'none' });
view.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfdbe6, 3500, 9000);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 2, 40000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 30; controls.maxDistance = 7000;
// Lokales Koordinatensystem: x = Ost, y = Nord, z = Höhe (m über h0). Root dreht in three.js (y oben).
const root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);

const hemi = new THREE.HemisphereLight(0xeef4ff, 0x8a8070, 1.6); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-1500, 2200, 1200); sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -1600, right: 1600, top: 1600, bottom: -1600, near: 10, far: 8000 });
sun.shadow.mapSize.set(Q.shadow, Q.shadow); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
scene.add(sun); scene.add(sun.target);
// Nachbearbeitung + Qualitätsstufen (Auswahl wird im Browser gespeichert)
const post = new Post(renderer, scene, camera); post.setQuality(QN);
function setQuality(name) {
  QN = name; Q = QUALITY[name]; saveQuality(name); post.setQuality(name);
  if (sun.shadow.mapSize.x !== Q.shadow) { sun.shadow.mapSize.set(Q.shadow, Q.shadow); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  shadowHalf = 0; $('quality').value = name;
}
window.__setQuality = setQuality; window.__LAMP = LAMP;

let META, H0, LON0, LAT0, MLON, MLAT, HGRID;
const toLocal = (lon, lat) => [(lon - LON0) * MLON, (lat - LAT0) * MLAT];
const toWorld = (x, y, z) => new THREE.Vector3(x, z, -y);
function heightAt(lon, lat) { // Gelände (m über h0), bilinear aus DGM1-Raster
  const g = META.grid, [w, s, e, n] = g.bbox;
  const fx = (lon - w) / (e - w) * (g.w - 1), fy = (n - lat) / (n - s) * (g.h - 1);
  const cx = Math.min(Math.max(fx, 0), g.w - 1), cy = Math.min(Math.max(fy, 0), g.h - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(x0 + 1, g.w - 1), y1 = Math.min(y0 + 1, g.h - 1);
  const tx = cx - x0, ty = cy - y0, v = (x, y) => HGRID[y * g.w + x] * g.scale;
  return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
}

function setView(name) {
  const p = { riedbergplatz: [8.6350, 50.1795, 420, 380, 520], campus: [8.6305, 50.1725, 500, 450, 650], overview: [8.637, 50.178, 1700, 1500, 2600], nah: [8.6352, 50.1793, 60, 110, 70] }[name];
  const [x, y] = toLocal(p[0], p[1]); const z = heightAt(p[0], p[1]);
  controls.target.copy(toWorld(x, y, z));
  camera.position.copy(toWorld(x - p[2] * 0.3, y - p[3], z + p[4] * 0.6));
  controls.update();
}
window.__look = (x, y, z, d = 60) => { controls.target.copy(toWorld(x, y, z)); camera.position.copy(toWorld(x - d * 0.5, y - d, z + d * 0.6)); controls.update(); };
window.__cam = (p, t) => { follow = null; const w = ([lon, lat, h]) => { const [x, y] = toLocal(lon, lat); return toWorld(x, y, heightAt(lon, lat) + h); };
  camera.position.copy(w(p)); controls.target.copy(w(t)); controls.update(); };
document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => setView(b.dataset.view));

// ---------- Gelände ----------
let terrain, orthoTex = null, hillTex = null;
async function loadTerrain() {
  META = await (await fetch('data/terrain.json')).json();
  H0 = META.h0; [LON0, LAT0] = META.origin;
  const R = 6378137; MLON = 2 * Math.PI * R / 360 * Math.cos(LAT0 * Math.PI / 180); MLAT = 2 * Math.PI * R / 360;
  HGRID = new Uint16Array(await (await fetch('data/height.bin')).arrayBuffer());
  const buf = await (await fetch('data/terrain.bin')).arrayBuffer();
  const n = META.vertexCount, m = META.indexCount;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 0, n * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buf, n * 12, n * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf, n * 24, n * 2), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, n * 32, m), 1));
  hillTex = await new THREE.TextureLoader().loadAsync('data/hillshade.jpg');
  hillTex.colorSpace = THREE.SRGBColorSpace; hillTex.anisotropy = 8;
  const tm = new THREE.MeshStandardMaterial({ map: hillTex, roughness: 0.95, metalness: 0 });
  tm.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uCore: SH.uCore, uCoreXf: SH.uCoreXf, uHasCore: SH.uTerrCore });
    sh.fragmentShader = 'uniform sampler2D uCore; uniform vec4 uCoreXf; uniform float uHasCore;\n' + sh.fragmentShader.replace('#include <map_fragment>', `
      vec2 cuv = vMapUv * uCoreXf.zw + uCoreXf.xy;
      bool inCore = uHasCore > 0.5 && all(greaterThan(cuv, vec2(0.001))) && all(lessThan(cuv, vec2(0.999)));
      vec4 sampledDiffuseColor = inCore ? texture2D(uCore, cuv) : texture2D(map, vMapUv);
      diffuseColor *= sampledDiffuseColor;`);
  };
  withLampLight(tm);
  terrain = new THREE.Mesh(g, tm); g.computeBoundingBox();
  terrain.receiveShadow = true; root.add(terrain);
  loadOrtho();
}
// Luftbild DOP20 (HVBG, dl-de/zero-2-0): lokal zwischengespeicherter WMS-Ausschnitt (data/dop.jpg, 1 m/px, EPSG:25832),
// deckt exakt die Geländekachel ab. Fallback: Live-WMS (max. 3000 px, CORS erlaubt). Sonst: Schummerung aus DGM1.
function loadOrtho() {
  const [x0, y0, x1, y1] = META.utm_bbox;
  const wms = 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
    + `&LAYERS=he_dop20_rgb&STYLES=default&FORMAT=image/jpeg&CRS=EPSG:25832&BBOX=${x0},${y0},${x1},${y1}&WIDTH=3000&HEIGHT=3000`;
  const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous');
  const ok = (t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; orthoTex = t; SH.uDop.value = t;
    if ($('l-ortho').checked) { terrain.material.map = t; terrain.material.needsUpdate = true; }
  };
  const fail = () => {
    $('l-ortho').checked = false; $('l-ortho').disabled = true; $('attr-ortho').style.display = 'none';
    status('Luftbild nicht ladbar – Ersatz: Schummerung aus DGM1.');
  };
  loader.load('data/dop.jpg', ok, undefined, () => loader.load(wms, ok, undefined, fail));
  // höher aufgelöster Kern-Ausschnitt (1,5 x 1,5 km um Riedbergplatz/Campus, 3000 px = 0,5 m/px) direkt vom freien HVBG-WMS (CORS erlaubt)
  const [cx0, cy0, cx1, cy1] = CORE_BBOX, CW = cx1 - cx0, CH = cy1 - cy0;
  SH.uCoreXf.value.set((x0 - cx0) / CW, (y0 - cy0) / CH, (x1 - x0) / CW, (y1 - y0) / CH);
  const coreUrl = wms.replace(/BBOX=[^&]+/, `BBOX=${CORE_BBOX.join(',')}`);
  loader.load(coreUrl, (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; SH.uCore.value = t; SH.uHasCore.value = 1;
    SH.uTerrCore.value = $('l-ortho').checked ? 1 : 0; }, undefined, () => console.warn('Kern-Luftbild nicht ladbar'));
}
const CORE_BBOX = [473010, 5557520, 474510, 5559020]; // EPSG:25832
// gemeinsame Shader-Uniforms (Gebäude, Gelände)
const SH = { uDop: { value: null }, uCore: { value: null }, uCoreXf: { value: new THREE.Vector4(0, 0, 1, 1) }, uHasCore: { value: 0 }, uTerrCore: { value: 0 },
  uNight: { value: 0 }, uSkyCol: { value: new THREE.Color(0.6, 0.7, 0.85) }, uSel: { value: -1 } };
$('l-ortho').onchange = (e) => { if (!terrain) return; terrain.material.map = e.target.checked && orthoTex ? orthoTex : hillTex; terrain.material.needsUpdate = true;
  SH.uTerrCore.value = e.target.checked ? SH.uHasCore.value : 0; };
$('l-terrain').onchange = (e) => { if (terrain) terrain.visible = e.target.checked; };

// ---------- Gebäude (LoD2) ----------
const FUNKTION = { '1000': 'Wohngebäude', '1010': 'Wohnhaus', '1313': 'Gartenhaus', '2000': 'Gebäude für Wirtschaft oder Gewerbe', '2463': 'Garage',
  '3000': 'Gebäude für öffentliche Zwecke', '3020': 'Gebäude für Bildung und Forschung', '3021': 'Allgemein bildende Schule', '3023': 'Hochschulgebäude',
  '3024': 'Forschungsinstitut', '3041': 'Kirche' };
const KAT = ['Wohnen', 'Wirtschaft/Gewerbe', 'Öffentliche Zwecke', 'Sonstige'];
// Fassaden prozedural (keine offenen texturierten Fassaden für Frankfurt verfügbar), Dächer aus DOP20-Luftbild.
// Klassenbits: 0 Dach, 1-2 Kategorie, 3 ohne Fenster, 4 Glas/Hochschule
const BLD_VERT_HEAD = `attribute vec3 fuv; attribute float fcls; attribute float fbid;
varying vec3 vFuv; flat varying float vCls; flat varying float vBid;`;
const BLD_FRAG_HEAD = `uniform sampler2D uDop; uniform sampler2D uCore; uniform vec4 uCoreXf; uniform float uHasCore; uniform float uNight; uniform vec3 uSkyCol; uniform float uSel;
varying vec3 vFuv; flat varying float vCls; flat varying float vBid;
float h11(float p){ p = fract(p*0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h31(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }`;
const BLD_FRAG_COLOR = `
  vec3 fcol; float fRough = 0.9; float fGlass = 0.0; vec3 fEmis = vec3(0.0);
  {
    int c = int(vCls + 0.5); bool roof = (c & 1) == 1; int cat = (c >> 1) & 3; bool nowin = (c & 8) != 0; bool glassy = (c & 16) != 0;
    float h1 = h11(vBid * 7.31 + 0.5), h2 = h11(vBid * 3.17 + 11.0), h3 = h11(vBid * 1.91 + 5.0);
    if (roof) {
      vec2 cuv = vFuv.xy * uCoreXf.zw + uCoreXf.xy;
      bool inCore = uHasCore > 0.5 && all(greaterThan(cuv, vec2(0.001))) && all(lessThan(cuv, vec2(0.999)));
      fcol = inCore ? texture2D(uCore, cuv).rgb : texture2D(uDop, vFuv.xy).rgb;
      fcol *= 1.08; fRough = 0.85;
    } else {
      vec3 base;
      if (cat == 0) { // Wohnen: helle Putztöne
        vec3 p0 = vec3(0.93, 0.91, 0.86), p1 = vec3(0.95, 0.90, 0.80), p2 = vec3(0.88, 0.89, 0.88), p3 = vec3(0.92, 0.86, 0.78), p4 = vec3(0.82, 0.84, 0.86);
        base = h1 < 0.3 ? p0 : h1 < 0.5 ? p1 : h1 < 0.7 ? p2 : h1 < 0.87 ? p3 : p4;
        base *= 0.94 + 0.08 * h2;
      } else if (cat == 1) base = mix(vec3(0.60, 0.62, 0.64), vec3(0.78, 0.76, 0.72), h1);   // Gewerbe: Beton/Metall
      else if (cat == 2) base = glassy ? mix(vec3(0.66, 0.67, 0.68), vec3(0.80, 0.79, 0.76), h1) : mix(vec3(0.82, 0.80, 0.74), vec3(0.90, 0.88, 0.82), h1);
      else base = mix(vec3(0.70, 0.68, 0.64), vec3(0.82, 0.80, 0.76), h1);
      base = lin(base);
      float u = vFuv.x, v = vFuv.y, hw = vFuv.z;
      bool com = glassy || cat == 1;
      float storey = com ? 3.6 : 2.9;
      float spacing = glassy ? 1.5 : (cat == 1 ? 2.4 : 2.7 + floor(h2 * 3.0) * 0.3);
      float winW = glassy ? 1.32 : (cat == 1 ? 1.8 : 1.15 + 0.25 * h3);
      float w0 = glassy ? 0.45 : 0.9, w1 = glassy ? 3.15 : 2.25;
      float fl = floor(v / storey), fv = v - fl * storey;
      float cell = floor(u / spacing + 0.5), fu = u - cell * spacing;
      float aa = max(fwidth(u), fwidth(v)) * 0.7 + 0.01;
      float inside = step(abs(u) + winW * 0.5 + 0.45, hw);
      float wx = 1.0 - smoothstep(winW * 0.5 - aa, winW * 0.5 + aa, abs(fu));
      float wy = smoothstep(w0 - aa, w0 + aa, fv) * (1.0 - smoothstep(w1 - aa, w1 + aa, fv));
      float fx = 1.0 - smoothstep(winW * 0.5 + 0.09 - aa, winW * 0.5 + 0.09 + aa, abs(fu));
      float fy = smoothstep(w0 - 0.09 - aa, w0 - 0.09 + aa, fv) * (1.0 - smoothstep(w1 + 0.09 - aa, w1 + 0.09 + aa, fv));
      float win = nowin ? 0.0 : wx * wy * inside;
      float frame = nowin ? 0.0 : max(fx * fy * inside - win, 0.0);
      // Haustür: Erdgeschoss, mittlere Achse, nur bei Wohngebäuden und ausreichend breiten Wänden (pro Wand per Hash)
      float door = 0.0;
      if (!nowin && cat == 0 && hw > 3.0 && fl < 0.5 && h11(vBid * 0.37 + hw * 13.1) < 0.45) {
        door = (1.0 - smoothstep(0.55 - aa, 0.55 + aa, abs(u))) * (1.0 - smoothstep(2.25 - aa, 2.25 + aa, v));
        win *= 1.0 - step(abs(u), 1.3);
        frame = max(frame * (1.0 - step(abs(u), 1.3)), (1.0 - smoothstep(0.65 - aa, 0.65 + aa, abs(u))) * (1.0 - smoothstep(2.35 - aa, 2.35 + aa, v)) - door);
      }
      // Gesims/Geschossband und Sockel
      float band = com ? 0.0 : (1.0 - smoothstep(0.0, 0.06 + aa, abs(fv - 0.02))) * 0.08;
      float plinth = 1.0 - smoothstep(0.35, 0.45, v);
      base *= (1.0 - band) * mix(1.0, 0.62, plinth) * mix(0.78, 1.0, smoothstep(0.0, 2.5, v));
      vec3 glass = glassy ? lin(vec3(0.20, 0.27, 0.32)) : lin(vec3(0.10, 0.12, 0.14));
      vec3 frameCol = cat == 0 ? lin(vec3(0.96, 0.96, 0.95)) : lin(vec3(0.30, 0.31, 0.33));
      vec3 doorCol = lin(mix(vec3(0.30, 0.22, 0.16), vec3(0.25, 0.27, 0.30), step(0.5, h3)));
      fcol = mix(mix(mix(base, frameCol, frame), glass, win), doorCol, door);
      fRough = mix(mix(0.92, 0.5, frame), 0.08, win);
      fGlass = win;
      // Nacht: zufällige Teilmenge erleuchteter Fenster (warm in Wohnungen, kühler in Büros)
      float lit = step(h31(vec3(vBid, cell + 101.0, fl + 7.0)), (com ? 0.18 : 0.33) * uNight) ;
      float var = 0.6 + 0.6 * h31(vec3(cell, fl, vBid + 3.0));
      fEmis = win * lit * var * (com ? vec3(0.75, 0.82, 0.95) : vec3(1.0, 0.62, 0.30)) * 1.1;
      fEmis += door * uNight * vec3(1.0, 0.75, 0.45) * 0.25;
    }
    if (abs(vBid - uSel) < 0.5) fcol = mix(fcol, vec3(1.0, 0.35, 0.02), 0.6);
  }
  diffuseColor.rgb = fcol;`;
function buildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    for (const k of ['uDop', 'uCore', 'uCoreXf', 'uHasCore', 'uNight', 'uSkyCol', 'uSel']) sh.uniforms[k] = SH[k];
    sh.vertexShader = BLD_VERT_HEAD + '\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vFuv = fuv; vCls = fcls; vBid = fbid;');
    sh.fragmentShader = BLD_FRAG_HEAD + '\n' + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + BLD_FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = fRough;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += fEmis + fGlass * uSkyCol * (0.06 + 0.35 * fres);`);
  };
  return m;
}
let buildings, BMETA, selected = -1;
async function loadBuildings() {
  BMETA = await (await fetch('data/buildings.json')).json();
  const buf = await (await fetch('data/buildings.bin')).arrayBuffer();
  const n = BMETA.vertexCount, m = BMETA.indexCount;
  const qp = new Int16Array(buf, 0, n * 3), pos = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) pos[i] = qp[i] * 0.1;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(buf, n * 6, n * 3), 3, true));
  g.setAttribute('fcls', new THREE.BufferAttribute(new Uint8Array(buf, n * 9, n), 1));
  const bidx = new Uint16Array(buf, n * 10, n);
  g.setAttribute('fbid', new THREE.BufferAttribute(bidx, 1));
  g.setAttribute('fuv', new THREE.BufferAttribute(new Float32Array(buf, n * 12, n * 3), 3));
  g.userData.bidx = bidx;
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, n * 24, m), 1));
  g.computeBoundingSphere();
  buildings = new THREE.Mesh(g, withLampLight(buildingMaterial(), '((int(vCls + 0.5) & 1) == 1 ? 0.0 : (1.0 - smoothstep(0.5, 11.0, vFuv.y)) * (1.0 - 0.7 * fGlass))'));
  buildings.castShadow = true; buildings.receiveShadow = true; root.add(buildings);
  status(`${BMETA.buildings.length.toLocaleString('de-DE')} Gebäude (LoD2) geladen.`);
}
$('l-buildings').onchange = (e) => { if (buildings) buildings.visible = e.target.checked; };
$('l-shadows').onchange = (e) => { sun.castShadow = e.target.checked; };

function highlight(bi) { selected = bi; SH.uSel.value = bi; }
function showBuilding(bi) {
  const b = BMETA.buildings[bi]; const code = (b.f || '').split('_').pop();
  const fn = FUNKTION[code] ? `${FUNKTION[code]} (${b.f})` : (b.f ? `Code ${b.f}` : 'k. A.');
  const cat = code.startsWith('1') ? 0 : code.startsWith('2') ? 1 : code.startsWith('3') ? 2 : 3;
  $('info').innerHTML = `<button class="close" title="Schließen">✕</button><h3>Gebäude</h3><table>
    <tr><td>Funktion</td><td>${fn}</td></tr><tr><td>Kategorie</td><td>${KAT[cat]}</td></tr>
    <tr><td>Höhe</td><td>${b.h != null ? b.h.toLocaleString('de-DE') + ' m' : 'k. A.'}</td></tr>
    <tr><td>Dachform</td><td>${b.r ? 'Code ' + b.r : 'k. A.'}</td></tr>
    <tr><td>Geländehöhe</td><td>${(b.z + H0).toFixed(1).replace('.', ',')} m ü. NHN</td></tr>
    <tr><td>Lage</td><td>${b.c[1].toFixed(5)}, ${b.c[0].toFixed(5)}</td></tr>
    <tr><td>ID</td><td style="font-size:10px">${b.id}</td></tr></table>
    <p style="font-size:10px;color:#666">Quelle: LoD2 Hessen, HVBG (dl-de/by-2-0)</p>`;
  $('info').hidden = false;
  $('info').querySelector('.close').onclick = () => { $('info').hidden = true; highlight(-1); };
}
const ray = new THREE.Raycaster(); let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => downAt = [e.clientX, e.clientY]);
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1), camera);
  if (vehGroup.visible) { const vh = ray.intersectObject(vehGroup, true).find((h) => vidOf(h.object));
    if (vh) { const v = vehicles.get(vidOf(vh.object)); if (v) { selectVehicle(v, true); return; } } }
  if (!buildings?.visible) return;
  const hit = ray.intersectObject(buildings)[0];
  if (hit) { const bi = buildings.geometry.userData.bidx[hit.face.a]; follow = null; selVeh = null; stopPopup = null; highlight(bi); showBuilding(bi); }
});

// ---------- ÖPNV: Haltestellen, Linien, Fahrzeuge (Transitous / MOTIS) ----------
const stopsGroup = new THREE.Group(), linesGroup = new THREE.Group(), vehGroup = new THREE.Group();
root.add(stopsGroup, linesGroup, vehGroup);
$('l-stops').onchange = (e) => { stopsGroup.visible = e.target.checked; stopsGroup.traverse((o) => { if (o.isCSS2DObject) o.element.style.display = e.target.checked ? '' : 'none'; }); };
$('l-lines').onchange = (e) => linesGroup.visible = e.target.checked;
$('l-vehicles').onchange = (e) => { vehGroup.visible = e.target.checked; vehGroup.traverse((o) => { if (o.isCSS2DObject) o.element.style.display = e.target.checked ? '' : 'none'; }); };
const short = (s) => (s || '').replace(/^Frankfurt \(Main\) /, '');
const bboxQ = `min=${BBOX.s},${BBOX.w}&max=${BBOX.n},${BBOX.e}`;

let _glow;
function glowTex() { // weicher Lichtpunkt für Haltestellen bei Nacht
  if (_glow) return _glow; const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return (_glow = new THREE.CanvasTexture(c));
}
async function loadStops() {
  const stops = await (await fetch(`${API}/v1/map/stops?${bboxQ}`)).json();
  const byName = new Map();
  for (const s of stops) { // nach Name gruppieren (Steige zusammenfassen)
    if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(s);
  }
  const sel = $('stop-select'); const known = new Set([...sel.options].map((o) => o.value));
  const pinGeo = new THREE.CylinderGeometry(1.6, 1.6, 14, 10).rotateX(Math.PI / 2).translate(0, 0, 7);
  for (const [name, list] of byName) {
    const lon = list.reduce((a, s) => a + s.lon, 0) / list.length, lat = list.reduce((a, s) => a + s.lat, 0) / list.length;
    const subway = list.some((s) => (s.modes || []).includes('SUBWAY'));
    const [x, y] = toLocal(lon, lat), z = heightAt(lon, lat);
    const pin = new THREE.Mesh(pinGeo, new THREE.MeshLambertMaterial({ color: subway ? 0x003a80 : 0xd4a017 }));
    pin.position.set(x, y, z); if (subway) pin.scale.set(1.6, 1.6, 1.8); stopsGroup.add(pin);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: subway ? 0xbfd8ff : 0xffd27a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    glow.position.set(x, y, z + (subway ? 26 : 15)); glow.scale.setScalar(subway ? 28 : 18); stopsGroup.add(glow); stopGlows.push(glow);
    const el = document.createElement('div'); el.className = 'slabel'; el.textContent = (subway ? 'Ⓤ ' : '') + short(name);
    if (!subway) el.style.borderLeftColor = '#d4a017';
    el.style.pointerEvents = 'auto';
    const parent = list.find((s) => s.parentId)?.parentId || list[0].stopId.split(':').slice(0, 3).join(':');
    el.onclick = () => { if (!known.has(parent)) { sel.add(new Option(short(name), parent)); known.add(parent); } sel.value = parent; stopPopup = short(name); loadDepartures(); };
    const lab = new CSS2DObject(el); lab.position.set(x, y, z + (subway ? 30 : 18)); lab.center.set(0.5, 1);
    if (!subway) el.style.fontSize = '10px';
    stopsGroup.add(lab);
  }
}

// Polyline-Decoder (Google-Format, Präzision 5)
function decode(str) {
  let i = 0, lat = 0, lon = 0; const out = [];
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let r = 0, sh = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      const d = (r & 1) ? ~(r >> 1) : (r >> 1); if (k === 0) lat += d; else lon += d;
    }
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}
const BUS_COL = { '24': '0097a7', '28': '7cb342', '29': 'e53935', '63': '8e24aa', '66': 'fb8c00', '71': '3949ab', 'M60': 'd81b60', 'M72': '00897b', 'M73': '6d4c41' };
function lineColor(seg) { const n = seg.trips?.[0]?.displayName || seg.displayName || seg.routeShortName || '';
  if (seg.routeColor) return seg.routeColor; if (BUS_COL[n]) return BUS_COL[n];
  if (seg.mode === 'BUS') { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return new THREE.Color().setHSL(h / 360, 0.6, 0.42).getHexString(); }
  return seg.mode === 'SUBWAY' ? '003a80' : '6a7a8a'; }
const inBox = ([lon, lat]) => lon > BBOX.w - 0.01 && lon < BBOX.e + 0.01 && lat > BBOX.s - 0.01 && lat < BBOX.n + 0.01;
const lineMats = new Map(), drawnSegs = new Set();
function lineMat(color) {
  if (!lineMats.has(color)) lineMats.set(color, new LineMaterial({ color: new THREE.Color('#' + color), linewidth: 4, resolution: new THREE.Vector2(innerWidth, innerHeight) }));
  return lineMats.get(color);
}
function prepSeg(seg) { // Polyline -> lokale Punkte + kumulierte Länge
  const pts = decode(seg.polyline).map(([lon, lat]) => { const [x, y] = toLocal(lon, lat); return [x, y, heightAt(lon, lat), lon, lat]; });
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}
function drawLine(seg, geo) {
  const key = (seg.trips[0]?.displayName || '') + seg.polyline; if (drawnSegs.has(key) || geo.pts.length < 2) return; drawnSegs.add(key);
  const off = seg.mode === 'SUBWAY' ? 1.2 : 0.8;
  const g = new LineGeometry(); g.setPositions(geo.pts.flatMap((p) => [p[0], p[1], p[2] + off]));
  linesGroup.add(new Line2(g, lineMat(lineColor(seg))));
}

// Fahrzeuge: Position zwischen Abfahrt und Ankunft eines Fahrtabschnitts interpoliert
const vehicles = new Map(); // tripId -> {segs:[...], mesh, label}
const BODY = { SUBWAY: [50, 2.65, 3.6], SUBURBAN: [75, 3.0, 4.2], REGIONAL_RAIL: [75, 3.0, 4.3], TRAM: [30, 2.4, 3.4], BUS: [12, 2.55, 3.2] };
const RAIL = new Set(['SUBWAY', 'SUBURBAN', 'REGIONAL_RAIL', 'TRAM']);
const CARS = { SUBWAY: 2, SUBURBAN: 3, REGIONAL_RAIL: 3, TRAM: 1 }; // Wagenzahl symbolisch (nicht in den Daten) // Ersatzgrößen, falls Modelle fehlen
const CAR_LEN = 25.4, CAR_GAP = 0.4; // U-Bahn: generisches U5-artiges Wagenmodell (türkis), Zuglänge symbolisch
function vehicleObj(seg) {
  const mode = BODY[seg.mode] ? seg.mode : 'BUS'; const [l, w, h] = BODY[mode];
  const hex = lineColor(seg); const col = new THREE.Color('#' + hex);
  let mesh = modelInstance(mode, hex);
  if (mesh && RAIL.has(mode)) { mesh.userData.cars = []; for (let k = 1; k < CARS[mode]; k++) { const c = modelInstance(mode, hex); vehGroup.add(c); mesh.userData.cars.push(c); } }
  if (!mesh) { mesh = new THREE.Mesh(new THREE.BoxGeometry(l, w, h).translate(0, 0, h / 2 + 0.3), new THREE.MeshLambertMaterial({ color: col, emissive: col, emissiveIntensity: 0.25 }));
    mesh.castShadow = true; }
  const el = document.createElement('div'); el.className = 'vlabel' + (seg.realTime ? '' : ' plan'); el.style.background = '#' + hex;
  el.textContent = seg.trips[0]?.displayName || '?'; el.title = 'Klicken: Details und Kamera folgt (Esc beendet)';
  el.style.pointerEvents = 'auto'; el.style.cursor = 'pointer'; const vid = seg.trips[0].tripId;
  el.onclick = (ev) => { ev.stopPropagation(); const v = vehicles.get(vid); if (v) selectVehicle(v, true); };
  mesh.userData.vid = vid; for (const c of mesh.userData.cars || []) c.userData.vid = vid;
  if (!$('l-vehicles').checked) el.style.display = 'none';
  const label = new CSS2DObject(el); label.position.set(0, 0, 10); label.center.set(0.5, 1); mesh.add(label);
  vehGroup.add(mesh); return mesh;
}
let lastPoll = null, pollErr = null;
const rt = new RT(RT_PROXY); let rtShownVer = -1;
function timeSeg(seg) { Object.assign(seg, rt.segTimes(seg)); seg.rtVer = rt.version; return seg; }
function vidOf(o) { while (o) { if (o.userData?.vid) return o.userData.vid; o = o.parent; } return null; }
async function pollRT() { if (!RT_PROXY) return; await rt.poll(); for (const v of vehicles.values()) { v.segs.forEach(timeSeg); v.segs.sort((a, b) => a.t0 - b.t0); } }
async function pollTrips(spanMs = POLL_MS * 3, linesOnly = false) {
  const now = Date.now();
  const q = `${API}/v5/map/trips?zoom=16&${bboxQ}&startTime=${new Date(now - 120000).toISOString()}&endTime=${new Date(now + spanMs).toISOString()}`;
  try {
    const segs = await (await fetch(q)).json();
    const fresh = new Map();
    for (const s of segs) {
      if (!['SUBWAY', 'BUS', 'TRAM', 'SUBURBAN', 'REGIONAL_RAIL'].includes(s.mode)) continue;
      const geo = prepSeg(s); if (!geo.pts.some((p) => inBox([p[3], p[4]]))) continue;
      drawLine(s, geo); if (linesOnly) continue;
      const id = s.trips[0].tripId; if (!fresh.has(id)) fresh.set(id, []);
      fresh.get(id).push(timeSeg({ ...s, geo }));
    }
    if (linesOnly) return;
    for (const [id, list] of fresh) {
      list.sort((a, b) => a.t0 - b.t0);
      const v = vehicles.get(id); if (v) v.segs = list; else vehicles.set(id, { segs: list, mesh: null });
    }
    for (const [id, v] of vehicles) if (!fresh.has(id) && v.segs.at(-1).t1 < now - 60000) { removeVehicle(v); vehicles.delete(id); }
    lastPoll = new Date(); pollErr = null;
  } catch (e) { pollErr = e; console.warn('Transitous nicht erreichbar', e); }
}
function removeVehicle(v) { if (v.mesh) { v.mesh.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); }); for (const c of v.mesh.userData.cars || []) vehGroup.remove(c); vehGroup.remove(v.mesh); v.mesh = null; } }
function posAlong(g, d) { // Punkt + Richtung bei Strecke d entlang der Polyline (vor dem Anfang linear extrapoliert)
  let i = 1; while (i < g.cum.length - 1 && g.cum[i] < d) i++;
  const a = g.pts[i - 1], b = g.pts[i] || a, sl = (g.cum[i] - g.cum[i - 1]) || 1, t = Math.min(1, (d - g.cum[i - 1]) / sl);
  const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, lon = a[3] + (b[3] - a[3]) * t, lat = a[4] + (b[4] - a[4]) * t;
  return { x, y, lon, lat, z: heightAt(lon, lat), rot: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
let rtHTML = '';
function updateVehicles() {
  const now = Date.now(); let nRT = 0, nPlan = 0, nG = 0, nCanc = 0;
  for (const v of vehicles.values()) {
    // aktiver Abschnitt, sonst Halt an der letzten erreichten Haltestelle (max. 90 s)
    if (v.segs.some((s) => s.trip?.cancelled)) { removeVehicle(v); v.cancelled = true; nCanc++; continue; }
    let seg = v.segs.find((s) => now >= s.t0 && now <= s.t1), f;
    if (seg) f = seg.t1 > seg.t0 ? (now - seg.t0) / (seg.t1 - seg.t0) : 1;
    else { const prev = v.segs.filter((s) => s.t1 < now).at(-1), next = v.segs.find((s) => s.t0 > now);
      if (prev && (next ? next.t0 - now < 600000 : now - prev.t1 < 90000)) { seg = prev; f = 1; }
      else if (next && next.t0 - now < 60000 && !prev) { seg = next; f = 0; } }
    if (!seg) { removeVehicle(v); continue; }
    const g = seg.geo; const d = f * g.len;
    const P = posAlong(g, d), lon = P.lon, lat = P.lat;
    if (lon < BBOX.w || lon > BBOX.e || lat < BBOX.s || lat > BBOX.n) { removeVehicle(v); continue; }
    if (!v.mesh) v.mesh = vehicleObj(seg);
    const isTrain = !!v.mesh.userData.cars, half = isTrain ? CAR_LEN / 2 : 6;
    const P0 = MODELS.SUBWAY || MODELS.BUS ? posAlong(g, d - half) : P;   // Modell-Mitte liegt eine halbe Länge hinter der Spitze
    v.mesh.position.set(P0.x, P0.y, P0.z); v.mesh.rotation.z = P0.rot;
    (v.mesh.userData.cars || []).forEach((c, k) => { const Q = posAlong(g, d - half - (k + 1) * (CAR_LEN + CAR_GAP)); c.position.set(Q.x, Q.y, Q.z); c.rotation.z = Q.rot; });
    v.seg = seg; v.f = f;
    const el = v.mesh.children.find((o) => o.isCSS2DObject).element, live = seg.src !== 'Fahrplan'; el.classList.toggle('plan', !live);
    const delay = seg.delay == null ? 0 : Math.round(seg.delay / 60);
    const txt = `${seg.trips[0].displayName}${live && delay ? (delay > 0 ? ' +' : ' −') + Math.abs(delay) : ''}`;
    if (el.textContent !== txt) el.textContent = txt;
    el.classList.toggle('late', live && delay >= 3); el.classList.toggle('sel', follow?.v === v);
    if (seg.src === 'gtfs.de') nG++; else if (live) nRT++; else nPlan++;
  }
  const t = lastPoll ? lastPoll.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' }) : '–';
  const rtt = rt.ok ? `gtfs.de-Echtzeit: ${rt.n} Fahrten, ${rt.cancelled} Ausfälle (Feed ${new Date(rt.feedTs * 1000).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })} Uhr)`
    : `gtfs.de-Echtzeit nicht verfügbar – ${rt.err || 'lädt …'}; Ersatz: Transitous`;
  const html = pollErr && !lastPoll ? 'ÖPNV-Daten nicht erreichbar.' :
    `${nG + nRT + nPlan} Fahrzeuge im Gebiet: <span class="badge rt">gtfs.de</span> ${nG} · <span class="badge rt2">Transitous-Echtzeit</span> ${nRT} · <span class="badge plan">Fahrplan</span> ${nPlan}${nCanc ? ` · <span class="late">${nCanc} Ausfall</span>` : ''}<br><small>${rtt}<br>Stand ${t} Uhr (Europe/Berlin) · Aktualisierung alle ${POLL_MS / 1000} s</small>`;
  if (html !== rtHTML) { rtHTML = html; $('rt-status').innerHTML = html; }
}

// Abfahrtstafel (Transitous), Verspätung bevorzugt aus gtfs.de-Echtzeit
const fmt = (iso) => new Date(iso).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
let stopPopup = null;
async function loadDepartures() {
  const id = $('stop-select').value;
  try {
    const d = await (await fetch(`${API}/v5/stoptimes?stopId=${encodeURIComponent(id)}&n=12`)).json();
    const rows = d.stopTimes.map((s) => {
      const p = s.place, sch = p.scheduledDeparture || p.scheduledArrival, dep = p.departure || p.arrival;
      const m = rt.find(s.displayName || s.routeShortName, p.lat, p.lon, Date.parse(sch) / 1000, p.scheduledDeparture ? 3 : 2);
      let delay = null, src = s.realTime ? 'Transitous' : 'Fahrplan', cancel = s.cancelled || s.tripCancelled || p.cancelled;
      if (m) { const st = m.trip.stops[m.k]; delay = st[5] ?? st[4]; src = 'gtfs.de'; cancel = cancel || m.trip.cancelled || st[6] === 1; }
      else if (s.realTime) delay = (Date.parse(dep) - Date.parse(sch)) / 1000;
      const col = '#' + lineColor(s), dm = delay == null ? null : Math.round(delay / 60);
      const dl = cancel ? '<span class="late">Ausfall</span>' : dm == null ? '' : dm > 0 ? `<span class="late">+${dm}</span>` : dm < 0 ? `<span class="ontime">${dm}</span>` : '<span class="ontime">pünktl.</span>';
      return `<tr class="${cancel ? 'cancel' : ''}"><td>${fmt(sch)}</td><td><span class="line" style="background:${col}">${s.displayName}</span></td><td>${short(s.headsign)}</td><td>${dl}</td><td><span class="badge ${src === 'gtfs.de' ? 'rt' : src === 'Transitous' ? 'rt2' : 'plan'}">${src}</span></td></tr>`;
    });
    const html = `<table>${rows.join('')}</table><small>Abgerufen ${new Date().toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin' })} Uhr (Europe/Berlin) · Verspätung: gtfs.de (SIRI Hessen) bzw. Transitous</small>`;
    $('departures').innerHTML = html;
    if (stopPopup) { follow = null; selVeh = null;
      $('info').innerHTML = `<button class="close" title="Schließen">✕</button><h3>Haltestelle ${stopPopup}</h3>${html}`; $('info').hidden = false;
      $('info').querySelector('.close').onclick = () => { $('info').hidden = true; stopPopup = null; }; }
  } catch (e) { $('departures').textContent = 'Abfahrten nicht abrufbar.'; }
}
$('stop-select').onchange = loadDepartures;


// ---------- Himmel, Wolken, Niederschlag ----------
const { sky, over } = makeSky(scene); // physikalischer Himmel (three.js Sky) + Überlagerung für Wolkendecke/Nacht/Sterne

const clouds = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide,
  uniforms: { uCov: { value: 0.2 }, uOff: { value: new THREE.Vector2() }, uLit: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.6, 0.62, 0.66) }, uFade: { value: 1 } },
  vertexShader: `varying vec2 vP; varying float vDist; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xz; vDist = length(w.xz - cameraPosition.xz); gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform float uCov, uFade; uniform vec2 uOff; uniform vec3 uLit, uShade; varying vec2 vP; varying float vDist;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
    void main(){ vec2 p = (vP + uOff) / 2600.0; float n = fbm(p);
      float th = 1.0 - uCov; float a = smoothstep(th - 0.08, th + 0.22, n) * (0.35 + 0.6 * uCov);
      a *= (1.0 - smoothstep(14000.0, 28000.0, vDist)) * uFade;
      vec3 c = mix(uLit, uShade, smoothstep(0.4, 0.9, n) * 0.8 + uCov * 0.2);
      gl_FragColor = vec4(c, a); }`,
}));
clouds.position.y = 2600; clouds.renderOrder = -5; clouds.frustumCulled = false; scene.add(clouds);

function makePrecip(N, lines) {
  const g = new THREE.BufferGeometry(), seed = new Float32Array(N * (lines ? 2 : 1) * 3), end = new Float32Array(N * (lines ? 2 : 1));
  for (let i = 0; i < N; i++) { const s = [Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < (lines ? 2 : 1); k++) { const j = lines ? i * 2 + k : i; seed.set(s, j * 3); end[j] = k; } }
  g.setAttribute('position', new THREE.BufferAttribute(seed, 3)); g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { uC: { value: new THREE.Vector3() }, uBox: { value: 600 }, uT: { value: 0 }, uSpeed: { value: lines ? 9 : 1.2 }, uWind: { value: new THREE.Vector2() },
      uCol: { value: new THREE.Color(lines ? 0xaab4c0 : 0xffffff) }, uA: { value: lines ? 0.55 : 0.9 }, uSize: { value: 4 } },
    vertexShader: `attribute float aEnd; uniform vec3 uC; uniform float uBox, uT, uSpeed, uSize; uniform vec2 uWind;
      void main(){ vec3 s = position; float H = uBox * 0.6;
        float y = mod(s.y * H - uT * uSpeed, H);
        vec3 p = vec3((s.x - 0.5) * uBox, y - H * 0.5, (s.z - 0.5) * uBox);
        p.xz += uWind * (H - y) / uSpeed;
        ${lines ? 'p.y += aEnd * uBox / 300.0 * 3.5; p.xz -= aEnd * uWind / uSpeed * 1.3;' : 'p.x += sin(uT * 0.9 + s.z * 40.0) * 1.5; p.z += cos(uT * 0.7 + s.x * 40.0) * 1.5;'}
        vec4 mv = modelViewMatrix * vec4(p + uC, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = uSize * 300.0 / max(-mv.z, 1.0); }`,
    fragmentShader: `uniform vec3 uCol; uniform float uA; void main(){ ${lines ? '' : 'vec2 q = gl_PointCoord - 0.5; if (dot(q, q) > 0.25) discard;'} gl_FragColor = vec4(uCol, uA); }`,
  });
  const o = lines ? new THREE.LineSegments(g, mat) : new THREE.Points(g, mat);
  o.frustumCulled = false; o.visible = false; scene.add(o); return o;
}
const rain = makePrecip(30000, true), snow = makePrecip(16000, false);

// ---------- Zeit (Europe/Berlin) ----------
let manualMin = null; // null = Echtzeit
function simDate() {
  const now = new Date(); if (manualMin == null) return now;
  const p = berlinParts(now); return berlinDate(p.y, p.m, p.d, manualMin);
}
const pad = (n) => String(n).padStart(2, '0');
function setTimeMode(min) {
  manualMin = min; if (min != null) $('time-slider').value = min;
  $('timemode').textContent = min == null ? 'Echtzeit' : 'Simuliert'; $('timemode').className = 'badge ' + (min == null ? 'rt' : 'plan');
}
$('time-slider').oninput = (e) => setTimeMode(+e.target.value);
$('btn-now').onclick = () => setTimeMode(null);
window.__setTime = (min) => setTimeMode(min);

// ---------- Wetter (Bright Sky / DWD, Fallback Open-Meteo) ----------
let WX = null, preview = '';
const num = (v, d = 1) => v == null ? '–' : v.toFixed(d).replace('.', ',');
async function loadWeather() {
  try {
    WX = await fetchWeather(50.178, 8.636);
    const t = WX.time.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
    $('weather').innerHTML = `<div class="wx-main"><span class="wx-ico">${WX.emoji}</span><span class="wx-temp">${num(WX.temp)} °C</span><span>${WX.text}</span></div>
      <table class="wx"><tr><td>Wind</td><td>${num(WX.wind, 0)} km/h aus ${windDir(WX.windDeg)}${WX.gust ? ` (Böen ${num(WX.gust, 0)})` : ''}</td></tr>
      <tr><td>Bewölkung</td><td>${WX.cloud == null ? '–' : WX.cloud + ' %'}</td></tr>
      <tr><td>Sicht</td><td>${WX.vis == null ? '–' : WX.vis >= 1000 ? num(WX.vis / 1000, 1) + ' km' : WX.vis + ' m'}</td></tr>
      <tr><td>Niederschlag</td><td>${num(WX.precip, 1)} mm</td></tr>
      <tr><td>Luftfeuchte</td><td>${WX.humidity == null ? '–' : WX.humidity + ' %'}</td></tr></table>
      <small>Messung ${t} Uhr · ${WX.src}${WX.station ? ' · Station ' + WX.station : ''} · Aktualisierung alle 10 min</small>`;
  } catch (e) { console.warn('Wetter nicht abrufbar', e); $('weather').textContent = 'Wetterdaten nicht abrufbar.'; }
}
$('wx-preview').onchange = (e) => { preview = e.target.value; };
window.__setWeather = (p) => { preview = p; $('wx-preview').value = p; };
function effWeather() {
  const base = WX || { cloud: 30, vis: 20000, precipType: null, fog: false, storm: false, wind: 10, windDeg: 270 };
  return preview ? { ...base, ...PRESETS[preview] } : base;
}

// ---------- Beleuchtung je nach Sonnenstand und Wetter ----------
const RAD = Math.PI / 180, LAT = 50.178, LON = 8.636;
const C = (h) => new THREE.Color(h);
const SKY = { dayTop: C(0x3f7fcf), dayHor: C(0xb9d3ec), ovTop: C(0x8c939c), ovHor: C(0xb4b9bf), dusk: C(0xf09a5a), duskTop: C(0x3a4f86),
  nightTop: C(0x02050f), nightHor: C(0x0b1322) };
const sstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const SKY_GAIN = 1.0; let shadowHalf = 0, furniture = null, streets = null;
let flash = 0, lastT = performance.now(), simTime = 0, cloudOff = new THREE.Vector2(), clockShown = '';
const stopGlows = [];
function updateEnvironment() {
  const nowP = performance.now(), dt = Math.min((nowP - lastT) / 1000, 0.1); lastT = nowP; simTime += dt;
  const date = simDate(), p = berlinParts(date);
  const shown = `${pad(p.hh)}:${pad(p.mm)}`;
  if (shown !== clockShown) { clockShown = shown; $('clock').textContent = `${pad(p.d)}.${pad(p.m)}.${p.y} · ${shown} Uhr`;
    if (manualMin == null) $('time-slider').value = p.hh * 60 + p.mm; }
  const sp = sunPosition(date, LAT, LON), alt = sp.altitude / RAD, az = sp.azimuth;
  const w = effWeather(), cov = Math.min(Math.max((w.cloud ?? 30) / 100, 0), 1), wet = w.precipType ? 1 : 0;
  const day = sstep(-6, 8, alt), lowSun = 1 - sstep(2, 20, alt), twi = sstep(-8, 0, alt) * (1 - sstep(4, 14, alt));
  const night = 1 - sstep(-5, 3, alt);
  // Sonnenrichtung im lokalen Rahmen (x Ost, y Nord, z oben) -> Welt
  const ca = Math.cos(sp.altitude), dl = new THREE.Vector3(-Math.sin(az) * ca, -Math.cos(az) * ca, Math.sin(sp.altitude));
  const dirW = new THREE.Vector3(dl.x, dl.z, -dl.y);
  const shade = 1 - 0.78 * Math.max(cov * cov, wet * 0.9);
  // mitgeführter Schattenausschnitt: Größe nach Blickabstand, Mitte leicht in Blickrichtung, auf Texel gerastert (kein Flimmern)
  const camD = camera.position.distanceTo(controls.target);
  const half = Math.min(Math.max(150 * Math.pow(1.18, Math.round(Math.log(Math.max(camD * 1.25 * Q.shadowK, 150) / 150) / Math.log(1.18))), 150), 1800);
  const sc = sun.shadow.camera, texel = 2 * half / sun.shadow.mapSize.x;
  if (half !== shadowHalf) { shadowHalf = half; Object.assign(sc, { left: -half, right: half, top: half, bottom: -half }); sc.updateProjectionMatrix(); }
  const fwd = controls.target.clone().sub(camera.position); fwd.y = 0; fwd.normalize();
  const ctr = controls.target.clone().addScaledVector(fwd, half * 0.35); ctr.x = Math.round(ctr.x / texel) * texel; ctr.z = Math.round(ctr.z / texel) * texel;
  sun.shadow.normalBias = Math.max(0.04, texel * 0.9);
  if (alt > 0) {
    sun.position.copy(ctr).addScaledVector(dirW, 4000); sun.target.position.copy(ctr);
    sun.intensity = 3.2 * sstep(-1, 8, alt) * shade;
    sun.color.setRGB(1, 0.93 - 0.3 * lowSun, 0.85 - 0.5 * lowSun);
  } else { // kühles Mondlicht (schematisch) + Himmelslicht über die Hemisphäre
    sun.position.copy(ctr).add(new THREE.Vector3(-800, 2500, 1200)); sun.target.position.copy(ctr);
    sun.intensity = 0.07; sun.color.setRGB(0.6, 0.72, 1.0);
  }
  sun.target.updateMatrixWorld();
  sun.castShadow = $('l-shadows').checked && alt > 0.5 && shade > 0.35;
  hemi.intensity = 0.1 - 0.06 * night + 1.25 * day * (1 - 0.25 * cov) + flash * 6;
  hemi.color.setRGB(0.55 + 0.45 * day, 0.66 + 0.34 * day, 1); hemi.groundColor.setRGB(0.45 * day + 0.07, 0.42 * day + 0.06, 0.38 * day + 0.06);
  // Himmelsfarben
  const top = SKY.dayTop.clone().lerp(SKY.ovTop, cov * 0.85 + wet * 0.15).lerp(SKY.duskTop, twi * 0.6).lerp(SKY.nightTop, night);
  const hor = SKY.dayHor.clone().lerp(SKY.ovHor, cov * 0.85 + wet * 0.15).lerp(SKY.dusk, twi * (1 - cov * 0.7)).lerp(SKY.nightHor, night);
  if (flash > 0) { top.lerp(C(0xdde4ff), flash); hor.lerp(C(0xdde4ff), flash); }
  const ku = sky.material.uniforms; ku.sunPosition.value.copy(dirW);
  ku.turbidity.value = 2.6 + 6 * cov + 3 * wet; ku.rayleigh.value = 1.1 + 1.2 * cov + 0.8 * twi; ku.mieCoefficient.value = 0.004 + 0.012 * cov;
  ku.uGain.value = SKY_GAIN;
  const su = over.material.uniforms; su.uTop.value.copy(top); su.uHor.value.copy(hor); su.uSunDir.value.copy(dirW);
  su.uSunVis.value = sstep(-1, 1, alt) * cov * 0.6; su.uStars.value = night * (1 - cov);
  su.uA.value = Math.min(Math.max(Math.min(cov * 0.85 + wet * 0.2, 0.96), night * 0.9, flash), 1);
  sky.position.copy(camera.position); over.position.copy(camera.position);
  SH.uSkyCol.value.copy(hor).multiplyScalar(0.8);
  // Wolkenschicht
  const cu = clouds.material.uniforms, wind = (w.wind ?? 10) / 3.6, wd = (w.windDeg ?? 270) * RAD;
  const wv = new THREE.Vector2(-Math.sin(wd), Math.cos(wd)).multiplyScalar(wind); // Welt-xz: x Ost, z Süd -> Wind nach (−sin, +cos)
  cloudOff.addScaledVector(wv, -dt * 4);
  cu.uCov.value = cov; cu.uOff.value.copy(cloudOff);
  cu.uLit.value.setRGB(1, 0.97 - 0.2 * twi, 0.93 - 0.35 * twi).multiplyScalar(0.15 + 0.85 * day);
  cu.uShade.value.setRGB(0.55, 0.57, 0.62).multiplyScalar(0.12 + 0.8 * day * (1 - 0.35 * wet));
  cu.uFade.value = 1 - sstep(1800, 2400, camera.position.y);
  clouds.position.x = camera.position.x; clouds.position.z = camera.position.z;
  // Nebel/Sichtweite
  const vis = Math.max(w.vis ?? 20000, 150), far = Math.min(Math.max(vis * 0.9, 300), 14000) * (w.precipType ? 0.7 : 1);
  scene.fog.far = far; scene.fog.near = w.fog ? far * 0.05 : far * 0.35; scene.fog.color.copy(hor).multiplyScalar(0.9);
  // Niederschlag
  const mid = camera.position.clone().lerp(controls.target, 0.55), box = Math.min(Math.max(camera.position.distanceTo(controls.target) * 0.9, 250), 1600);
  for (const o of [rain, snow]) { const u = o.material.uniforms; u.uC.value.copy(mid); u.uBox.value = box; u.uT.value = simTime; u.uWind.value.copy(wv).multiplyScalar(0.6); }
  rain.visible = w.precipType === 'rain'; snow.visible = w.precipType === 'snow';
  rain.material.uniforms.uSpeed.value = 9 * box / 300; rain.material.uniforms.uCol.value.setRGB(0.8, 0.84, 0.9).multiplyScalar(0.3 + 0.7 * day);
  snow.material.uniforms.uSpeed.value = 1.3 * box / 300; snow.material.uniforms.uSize.value = 0.6 * box / 300;
  if (w.storm && Math.random() < dt * 0.15) flash = 1; flash = Math.max(0, flash - dt * 4);
  // Nachtbeleuchtung
  SH.uNight.value = night + (1 - night) * 0.15 * cov * (1 - day * 0.8);
  renderer.toneMappingExposure = 1.0 + 0.25 * night;
  const lampsOn = 1 - sstep(-3, 3, alt) * (1 - 0.6 * sstep(0.85, 1, cov) * (1 - day * 0.5)); // Dämmerungsschalter
  LAMP.night.value = lampsOn; post.setNight(lampsOn); furniture?.update(lampsOn, Date.now() / 1000);
  for (const g of stopGlows) g.material.opacity = 0.9 * night;
  VEH_MATS.light.forEach((m) => { m.emissiveIntensity = 0.3 + 4 * night; });
  VEH_MATS.glass.forEach((m) => { m.emissive.setRGB(1, 0.85, 0.6); m.emissiveIntensity = 0.5 * night; });
  $('suninfo').textContent = `Sonne: ${alt > 0 ? 'Höhe ' + alt.toFixed(0) + '°' : 'unter dem Horizont'}, Richtung ${((az / RAD + 180) % 360).toFixed(0)}°`;
}

// ---------- Bäume (Baumkataster Frankfurt) ----------
const treesGroup = new THREE.Group(); root.add(treesGroup);
$('l-trees').onchange = (e) => treesGroup.visible = e.target.checked;
const AUTUMN = { Acer: 0xd99a2b, Tilia: 0xc9b03a, Carpinus: 0xb08a3a, Quercus: 0x8e6b30, Prunus: 0xc0552f, Fraxinus: 0xb7b04a, Betula: 0xd9c040,
  Sorbus: 0xc0552f, Liquidambar: 0xa8322a, Platanus: 0xa58a4a, Robinia: 0xb9b24a, Malus: 0xb6763a, Pyrus: 0xb0442f, Ginkgo: 0xe2c22a };
async function loadTrees() {
  const meta = await (await fetch('data/trees.json')).json();
  const a = new Float32Array(await (await fetch('data/trees.bin')).arrayBuffer()), n = meta.count;
  const month = berlinParts(new Date()).m;
  const autumn = month === 10 ? 0.55 : month === 11 ? 0.8 : 0, winter = month === 12 || month <= 3;
  const nCon = [...Array(n).keys()].filter((i) => a[i * 7 + 5] > 0.5).length, nDec = n - nCon;
  const trunkG = new THREE.CylinderGeometry(0.6, 1, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5);
  const crownG = new THREE.IcosahedronGeometry(1, 2), pp = crownG.attributes.position;
  for (let i = 0; i < pp.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pp, i); const k = 0.82 + 0.3 * Math.abs(Math.sin(v.x * 5.1 + v.y * 3.7) * Math.cos(v.z * 4.3 + v.x * 2.1)); pp.setXYZ(i, v.x * k, v.y * k, v.z * k); }
  crownG.computeVertexNormals();
  const coneG = new THREE.ConeGeometry(1, 1, 9).rotateX(Math.PI / 2);
  const leafM = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 1 }), n);
  const crowns = new THREE.InstancedMesh(crownG, leafM, nDec), cones = new THREE.InstancedMesh(coneG, leafM, Math.max(nCon, 1));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), green = new THREE.Color();
  let ic = 0, io = 0;
  for (let i = 0; i < n; i++) {
    const [x, y, z, h, d, con, gi] = a.subarray(i * 7, i * 7 + 7); const gen = meta.genera[gi];
    const r = Math.max(d / 2, 0.6), hh = Math.max(h, 2);
    const rnd = ((gi * 9301 + i * 49297) % 233280) / 233280;
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rnd * 6.28);
    green.setHSL(0.24 + 0.06 * ((gi * 0.37) % 1), 0.38 + 0.15 * rnd, 0.2 + 0.06 * rnd);
    if (con) {
      const ch = hh * 0.82;
      m.compose(new THREE.Vector3(x, y, z + hh - ch / 2), q, new THREE.Vector3(r * 0.9, r * 0.9, ch)); cones.setMatrixAt(io, m);
      col.setHSL(0.36, 0.35, 0.14 + 0.05 * rnd); cones.setColorAt(io++, col);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(0.25, 0.25, hh - ch * 0.8)); trunks.setMatrixAt(i, m);
    } else {
      const vr = Math.min(Math.max(r * 0.95, 1.2), hh * 0.42), cz = z + hh - vr;
      const s = winter ? 0.8 : 1;
      m.compose(new THREE.Vector3(x, y, cz), q, new THREE.Vector3(r * s, r * s, vr * s)); crowns.setMatrixAt(ic, m);
      col.copy(green);
      if (autumn) col.lerp(new THREE.Color(AUTUMN[gen] ?? 0xa9a040).convertSRGBToLinear(), autumn * (0.55 + 0.45 * rnd));
      if (winter) col.setRGB(0.12, 0.1, 0.08);
      crowns.setColorAt(ic++, col);
      const tr = Math.min(0.12 + d * 0.025, 0.6);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(tr, tr, cz - z)); trunks.setMatrixAt(i, m);
    }
  }
  for (const o of [trunks, crowns, cones]) { o.castShadow = true; o.receiveShadow = true; o.computeBoundingSphere(); treesGroup.add(o); }
  if (!nCon) cones.count = 0;
  return n;
}

// ---------- Fahrzeugmodelle (Blender -> glTF, generische Lackierung) ----------
const MODELS = {}; const VEH_MATS = { light: [], glass: [] };
async function loadModels() {
  const gl = new GLTFLoader();
  for (const [k, f] of [['SUBWAY', 'models/ubahn_u5.glb'], ['BUS', 'models/bus.glb']]) {
    try { const g = await gl.loadAsync(f); const obj = g.scene;
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true;
        if (o.material.name === 'Licht' || o.material.name === 'Scheinwerfer' || o.material.name === 'Anzeigefeld') VEH_MATS.light.push(o.material);
        if (o.material.name === 'Glas') VEH_MATS.glass.push(o.material); } });
      MODELS[k] = obj;
    } catch (e) { console.warn('Modell nicht ladbar', f, e); }
  }
}
function modelInstance(mode, color) {
  const src = MODELS[RAIL.has(mode) ? 'SUBWAY' : 'BUS']; if (!src) return null;
  const o = src.clone(true); const line = new THREE.Color('#' + color);
  o.traverse((c) => { if (c.isMesh && c.material.name === 'Linie') { c.material = c.material.clone(); c.material.color.copy(line); } });
  const holder = new THREE.Group(); o.rotation.x = Math.PI / 2; holder.add(o); return holder; // glTF y-oben -> lokal z-oben
}

// ---------- Start ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight); post.setSize(innerWidth, innerHeight);
  for (const m of lineMats.values()) m.resolution.set(innerWidth, innerHeight);
});
// Fahrzeug anklicken: Infofenster mit Verspätung, Kamera folgt (Esc beendet)
let follow = null, selVeh = null, infoTick = 0;
function vehicleHTML(v) {
  const seg = v.seg || v.segs[0], line = seg.trips[0].displayName, col = '#' + lineColor(seg);
  const hs = seg.trip?.hs || v.segs.at(-1).to?.name || '', live = seg.src !== 'Fahrplan';
  const tt = (ms) => new Date(ms).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  const sa = Date.parse(seg.scheduledArrival), sd = Date.parse(seg.scheduledDeparture);
  const dl = seg.cancelled ? '<span class="late">Ausfall</span>' : seg.delay == null ? '<span class="badge plan">keine Echtzeit</span>'
    : `<span class="${Math.round(seg.delay / 60) >= 3 ? 'late' : 'ontime'}">${fmtDelay(seg.delay)}</span>`;
  return `<button class="close" title="Schließen">✕</button><h3><span class="line" style="background:${col}">${line}</span> ${MODE_DE[seg.mode] || ''}</h3>
    <table><tr><td>Richtung</td><td>${short(hs.replace(/^F /, 'Frankfurt (Main) ')) || '–'}</td></tr>
    <tr><td>Verspätung</td><td>${dl}</td></tr>
    <tr><td>Von</td><td>${short(seg.from.name)} · plan ${tt(sd)}${live ? ` · ist ${tt(seg.t0)}` : ''}</td></tr>
    <tr><td>Nächster Halt</td><td>${short(seg.to.name)} · plan ${tt(sa)}${live ? ` · erwartet ${tt(seg.t1)}` : ''}</td></tr>
    <tr><td>Quelle</td><td><span class="badge ${seg.src === 'gtfs.de' ? 'rt' : seg.src === 'Transitous' ? 'rt2' : 'plan'}">${seg.src}</span>${seg.src === 'gtfs.de' ? ' SIRI Hessen (CC BY-SA 4.0)' : seg.src === 'Transitous' ? ' MOTIS/DELFI' : ''}</td></tr></table>
    <p class="hint">${follow?.v === v ? '🎥 Kamera folgt – <b>Esc</b> beendet' : '<a href="#" class="follow">Kamera folgen lassen</a>'}</p>`;
}
const MODE_DE = { SUBWAY: 'U-Bahn', BUS: 'Bus', TRAM: 'Straßenbahn', SUBURBAN: 'S-Bahn', REGIONAL_RAIL: 'Regionalzug' };
function showVehicleInfo() {
  const v = selVeh; if (!v) return; $('info').innerHTML = vehicleHTML(v); $('info').hidden = false;
  $('info').querySelector('.close').onclick = () => { $('info').hidden = true; selVeh = null; follow = null; };
  const a = $('info').querySelector('.follow'); if (a) a.onclick = (e) => { e.preventDefault(); selectVehicle(v, true); };
}
function selectVehicle(v, doFollow) {
  stopPopup = null; selVeh = v; highlight(-1);
  if (doFollow && v.mesh) { const p = v.mesh.position, T = toWorld(p.x, p.y, p.z + 2);
    if (follow?.v !== v) { const off = camera.position.clone().sub(controls.target); const d = Math.min(Math.max(off.length(), 45), 160);
      off.setLength(d); if (off.y < d * 0.35) off.y = d * 0.45; off.setLength(d); controls.target.copy(T); camera.position.copy(T).add(off); }
    follow = { v }; }
  showVehicleInfo();
}
addEventListener('keydown', (e) => { if (e.key === 'Escape' && follow) { follow = null; showVehicleInfo(); } });
window.__follow = (i, d = 60) => { if (i == null) { follow = null; return null; }
  const list = [...vehicles.values()].filter((x) => x.mesh); const v = typeof i === 'number' ? list[i] : list.find(i); if (!v) return null;
  follow = null; const p = v.mesh.position; controls.target.copy(toWorld(p.x, p.y, p.z)); camera.position.copy(toWorld(p.x - d * 0.6, p.y - d, p.z + d * 0.5));
  selectVehicle(v, true); return v.segs[0].trips[0].displayName; };
let fpsN = 0, fpsT = performance.now();
renderer.setAnimationLoop(() => {
  updateEnvironment(); if (META) updateVehicles();
  if (follow) { const v = follow.v;
    if (!v.mesh) { follow = null; if (selVeh === v) { $('info').innerHTML = '<button class="close">✕</button><p>Fahrzeug hat das Modellgebiet verlassen oder die Fahrt ist beendet.</p>'; $('info').querySelector('.close').onclick = () => { $('info').hidden = true; }; selVeh = null; } }
    else { const p = v.mesh.position, T = toWorld(p.x, p.y, p.z + 2), dlt = T.sub(controls.target); controls.target.add(dlt); camera.position.add(dlt); } }
  controls.update();
  if (selVeh && performance.now() - infoTick > 1000) { infoTick = performance.now(); showVehicleInfo(); }
  post.render(); labelRenderer.render(scene, camera);
  fpsN++; const nowP = performance.now(); if (nowP - fpsT > 1000) { $('fps').textContent = `${Math.round(fpsN * 1000 / (nowP - fpsT))} fps`; fpsN = 0; fpsT = nowP; }
});
$('quality').value = QN; $('quality').onchange = (e) => setQuality(e.target.value);
$('l-streets').onchange = (e) => { if (streets) streets.group.visible = e.target.checked; };
$('l-furniture').onchange = (e) => { if (furniture) furniture.group.visible = e.target.checked; };
(async () => {
  status('Lade Gelände …'); await loadTerrain(); setView('riedbergplatz');
  status('Lade Gebäude …'); await loadBuildings();
  loadWeather(); setInterval(loadWeather, 600000);
  status('Lade Straßen, Gleise und Stadtmöbel (OSM) …');
  try {
    const bb = terrain.geometry.boundingBox;
    [streets, furniture] = await Promise.all([loadStreets(root), loadFurniture(root, Q.lampTex, [bb.min.x, bb.min.y, bb.max.x, bb.max.y])]);
    streets.group.visible = $('l-streets').checked; furniture.group.visible = $('l-furniture').checked;
    $('osm-info').textContent = `OSM-Stand ${new Date(furniture.osmTs).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} · ${furniture.counts.lamps.toLocaleString('de-DE')} Laternen (${furniture.lampsOsm} kartiert, ${furniture.lampsAdded.toLocaleString('de-DE')} ergänzt)`;
  } catch (e) { console.warn('Straßen nicht ladbar', e); }
  status('Lade Bäume und Fahrzeugmodelle …');
  const [nT] = await Promise.all([loadTrees().catch((e) => { console.warn('Bäume nicht ladbar', e); return 0; }), loadModels()]);
  status(`${BMETA.buildings.length.toLocaleString('de-DE')} Gebäude (LoD2), ${nT.toLocaleString('de-DE')} Bäume (Baumkataster) geladen.`);
  window.__ready = true;
  loadStops().catch((e) => console.warn('Haltestellen nicht abrufbar', e));
  loadDepartures(); setInterval(loadDepartures, 60000);
  await pollRT(); if (RT_PROXY) setInterval(pollRT, POLL_MS);
  await pollTrips(); setInterval(() => pollTrips(), POLL_MS);
  pollTrips(90 * 60000, true); // Linienverläufe (aus Fahrtverläufen) vorladen
  window.__transitReady = true;
  window.__dbg = () => ({ lines: linesGroup.children.length, rt: { ok: rt.ok, n: rt.n, err: rt.err }, quality: QN,
    veh: [...vehicles.values()].filter((v) => v.mesh).map((v) => [v.segs[0].trips[0].displayName, v.mesh.position.x|0, v.mesh.position.y|0, v.mesh.position.z|0, v.seg?.src, v.seg?.delay]), stops: stopsGroup.children.length });
})();
