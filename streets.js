// Riedberg 3D – Straßen, Gleise und Stadtmöbel aus OpenStreetMap (© OSM-Mitwirkende, ODbL), vorberechnet mit tools/build_osm.py.
// Texturen: ambientCG (CC0). Alle Objekte im lokalen Rahmen (x Ost, y Nord, z oben, m über h0).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { withLampLight, buildLampMap } from './gfx.js';

const TEX = new THREE.TextureLoader();
function tex(name, srgb, aniso = 8) {
  const t = TEX.load('textures/' + name); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; return t;
}
function surface(base, tint, extra = {}) {
  return withLampLight(new THREE.MeshStandardMaterial({ map: tex(base + '_color.jpg', true), normalMap: tex(base + '_normal.jpg', false),
    roughnessMap: tex(base + '_rough.jpg', false), color: tint, metalness: 0, normalScale: new THREE.Vector2(0.7, 0.7),
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, ...extra }));
}
function stripeTex() { // Schwellen: 0,26 m Beton je 0,65 m
  const c = document.createElement('canvas'); c.width = 4; c.height = 64; const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 4, 64); g.fillStyle = '#fff'; g.fillRect(0, 0, 4, Math.round(64 * 0.26 / 0.65));
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.NearestFilter; return t;
}

const TILE = { asphalt: 3.5, paving: 2.4, gravel: 2.0, playground: 2.0 };
export async function loadStreets(root) {
  const meta = await (await fetch('data/streets.json')).json();
  const buf = await (await fetch('data/streets.bin')).arrayBuffer();
  const [qx, qy, qz] = meta.q;
  const M = {
    asphalt: surface('asphalt', 0x9c9c9c),
    paving: surface('paving', 0xd2cec6, { polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 }),
    gravel: surface('gravel', 0xa49d92),
    playground: withLampLight(new THREE.MeshStandardMaterial({ color: 0xb79b6c, roughness: 1, map: tex('gravel_color.jpg', true), polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -3 })),
    marking: withLampLight(new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -8 })),
    curb: withLampLight(new THREE.MeshStandardMaterial({ color: 0xb3b0a8, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })),
    rail: new THREE.MeshStandardMaterial({ color: 0x9da1a6, roughness: 0.32, metalness: 0.85, side: THREE.DoubleSide }),
    sleeper: withLampLight(new THREE.MeshStandardMaterial({ color: 0x8e8b85, roughness: 0.95, alphaMap: stripeTex(), alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })),
  };
  const group = new THREE.Group(); group.name = 'streets';
  let nv = 0;
  for (const [name, chunks] of Object.entries(meta.meshes)) {
    for (const c of chunks) {
      let off = c.off; const q = new Int16Array(buf, off, c.v * 3); off += c.v * 6;
      let along = null; if (name === 'sleeper') { along = new Float32Array(buf, off, c.v); off += c.v * 4; }
      off = (off + 3) & ~3; const idx = new Uint16Array(buf, off, c.i);
      const pos = new Float32Array(c.v * 3);
      for (let k = 0; k < c.v; k++) { pos[k * 3] = q[k * 3] * qx; pos[k * 3 + 1] = q[k * 3 + 1] * qy; pos[k * 3 + 2] = q[k * 3 + 2] * qz; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
      if (TILE[name]) { const uv = new Float32Array(c.v * 2), s = 1 / TILE[name]; for (let k = 0; k < c.v; k++) { uv[k * 2] = pos[k * 3] * s; uv[k * 2 + 1] = pos[k * 3 + 1] * s; } g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); }
      if (along) { const uv = new Float32Array(c.v * 2); for (let k = 0; k < c.v; k++) { uv[k * 2] = 0.5; uv[k * 2 + 1] = along[k] / 0.65; } g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); }
      g.computeVertexNormals(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, M[name]); m.receiveShadow = true; m.name = name; group.add(m); nv += c.v;
    }
  }
  root.add(group);
  return { group, meta, vertices: nv };
}

// ---------- Stadtmöbel (instanziert) ----------
const box = (w, d, h, x, y, z) => new THREE.BoxGeometry(w, d, h).translate(x, y, z);
const cyl = (r0, r1, h, x, y, z, seg = 8) => new THREE.CylinderGeometry(r1, r0, h, seg).rotateX(Math.PI / 2).translate(x, y, z + h / 2);
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo; const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g;
}
const merge = (parts) => mergeGeometries(parts.map(([g, c]) => colored(g, c)));
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
function inst(geo, mat, list, place, castShadow = true) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(list.length, 1)); m.count = list.length;
  list.forEach((it, i) => { const [p, rot, s] = place(it); tmpQ.setFromAxisAngle(Z, rot); tmpM.compose(p, tmpQ, s); m.setMatrixAt(i, tmpM); });
  m.castShadow = castShadow; m.receiveShadow = true; m.computeBoundingSphere(); return m;
}
const V = (x, y, z) => new THREE.Vector3(x, y, z), ONE = new THREE.Vector3(1, 1, 1);
const off = (x, y, rot, dx, dy) => [x + Math.cos(rot) * dx - Math.sin(rot) * dy, y + Math.sin(rot) * dx + Math.cos(rot) * dy];

export async function loadFurniture(root, lampTexSize, bounds) {
  const F = await (await fetch('data/furniture.json')).json();
  const group = new THREE.Group(); group.name = 'furniture';
  const vc = withLampLight(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.15 }));
  const metal = withLampLight(new THREE.MeshStandardMaterial({ color: 0x5d6166, roughness: 0.5, metalness: 0.6 }));
  const glow = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, emissive: 0xffd9a8, emissiveIntensity: 0.05, roughness: 0.4 });
  const adGlow = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, emissive: 0xe8f0ff, emissiveIntensity: 0.1, roughness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xcfe0ea, transparent: true, opacity: 0.25, roughness: 0.05, metalness: 0, depthWrite: false, side: THREE.DoubleSide });

  // Laternen: kleine Mastleuchten (< 7 m, Wege/Wohnstraßen) und Auslegerleuchten an Hauptstraßen
  const post = F.lamps.filter((l) => l[3] < 7), arm = F.lamps.filter((l) => l[3] >= 7);
  const poleG = cyl(0.075, 0.05, 1, 0, 0, 0, 6);
  group.add(inst(poleG, metal, F.lamps, (l) => [V(l[0], l[1], l[2]), 0, V(1, 1, l[3])]));
  const topHead = cyl(0.22, 0.16, 0.42, 0, 0, 0, 10), topCap = cyl(0.12, 0.26, 0.08, 0, 0, 0.42, 10);
  group.add(inst(topHead, glow, post, (l) => [V(l[0], l[1], l[2] + l[3]), 0, ONE], false));
  group.add(inst(topCap, metal, post, (l) => [V(l[0], l[1], l[2] + l[3]), 0, ONE], false));
  const armG = mergeGeometries([box(1.3, 0.07, 0.07, 0.6, 0, 0)]), armHead = box(0.62, 0.24, 0.07, 1.25, 0, -0.06);
  group.add(inst(armG, metal, arm, (l) => [V(l[0], l[1], l[2] + l[3]), l[4], ONE], false));
  group.add(inst(armHead, glow, arm, (l) => [V(l[0], l[1], l[2] + l[3]), l[4], ONE], false));

  // Bänke (Sitzfläche zeigt zum Weg = +x)
  const benchG = merge([[box(0.45, 1.8, 0.05, 0, 0, 0.45), 0x7a5a3a], [box(0.05, 1.8, 0.38, -0.21, 0, 0.72), 0x7a5a3a],
    [box(0.5, 0.06, 0.45, 0, -0.75, 0.22), 0x3d4145], [box(0.5, 0.06, 0.45, 0, 0.75, 0.22), 0x3d4145]]);
  group.add(inst(benchG, vc, F.benches, (b) => [V(b[0], b[1], b[2]), b[3], ONE]));
  group.add(inst(cyl(0.2, 0.22, 0.8, 0, 0, 0, 10), withLampLight(new THREE.MeshStandardMaterial({ color: 0x3f5a46, roughness: 0.6 })), F.baskets, (b) => [V(b[0], b[1], b[2]), 0, ONE]));

  // Ampeln: Mast + Gehäuse, Lichtpunkte (Fahrzeug: 3, Fußgänger: 2) mit eigener Phase je Knoten
  const sigG = merge([[cyl(0.07, 0.07, 3.4, 0, 0, 0, 8), 0x50555a], [box(0.22, 0.32, 0.95, 0.12, 0, 2.55), 0x1e2124]]);
  group.add(inst(sigG, vc, F.signals, (s) => [V(s[0], s[1], s[2]), s[3], ONE]));
  const lights = [];
  F.signals.forEach((s, i) => { const n = s[4] ? 2 : 3; for (let k = 0; k < n; k++) lights.push([s, k, n, i]); });
  const lampG = new THREE.CircleGeometry(0.1, 12).rotateY(Math.PI / 2).translate(0.235, 0, 0);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
  const sigLights = inst(lampG, lightMat, lights, ([s, k, n]) => [V(s[0], s[1], s[2] + 2.85 - k * (n === 2 ? 0.42 : 0.3)), s[3], ONE], false);
  sigLights.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lights.length * 3), 3);
  group.add(sigLights);

  // Haltestellen: Mast mit „H“-Schild, Wartehäuschen (Glas, Dach, beleuchtete Werbevitrine)
  const hc = document.createElement('canvas'); hc.width = hc.height = 128; const hg = hc.getContext('2d');
  hg.fillStyle = '#0a7a3c'; hg.beginPath(); hg.arc(64, 64, 62, 0, 7); hg.fill(); hg.fillStyle = '#f7d117'; hg.beginPath(); hg.arc(64, 64, 50, 0, 7); hg.fill();
  hg.fillStyle = '#0a7a3c'; hg.font = 'bold 76px sans-serif'; hg.textAlign = 'center'; hg.textBaseline = 'middle'; hg.fillText('H', 64, 68);
  const hTex = new THREE.CanvasTexture(hc); hTex.colorSpace = THREE.SRGBColorSpace;
  group.add(inst(cyl(0.04, 0.04, 2.9, 0, 0, 0, 6), metal, F.stopsigns, (s) => [V(s[0], s[1], s[2]), 0, ONE]));
  const signG = new THREE.CircleGeometry(0.3, 20).rotateX(Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0, 2.65);
  group.add(inst(signG, withLampLight(new THREE.MeshStandardMaterial({ map: hTex, side: THREE.DoubleSide, roughness: 0.5 })), F.stopsigns, (s) => [V(s[0], s[1], s[2]), s[3] + Math.PI / 2, ONE], false));
  const frameG = merge([[box(1.7, 3.8, 0.1, 0, 0, 2.5), 0x55595e], [box(0.08, 0.08, 2.45, -0.75, -1.85, 1.22), 0x55595e], [box(0.08, 0.08, 2.45, -0.75, 1.85, 1.22), 0x55595e],
    [box(0.08, 0.08, 2.45, 0.75, -1.85, 1.22), 0x55595e], [box(0.4, 2.2, 0.05, -0.5, 0, 0.47), 0x6b6f74]]);
  group.add(inst(frameG, vc, F.shelters, (s) => [V(s[0], s[1], s[2]), s[3], ONE]));
  const glassG = mergeGeometries([box(0.03, 3.6, 2.2, -0.75, 0, 1.25), box(1.3, 0.03, 2.2, -0.05, -1.85, 1.25)]);
  group.add(inst(glassG, glass, F.shelters, (s) => [V(s[0], s[1], s[2]), s[3], ONE], false));
  group.add(inst(box(1.2, 0.12, 1.75, -0.05, 1.85, 1.1), adGlow, F.shelters, (s) => [V(s[0], s[1], s[2]), s[3], ONE]));

  // Spielplätze: Schaukelgestell + Rutsche als Hinweis am Flächenmittelpunkt
  const swingG = merge([[cyl(0.06, 0.06, 2.5, -1.4, -0.5, 0), 0xb04a2a], [cyl(0.06, 0.06, 2.5, -1.4, 0.5, 0), 0xb04a2a], [cyl(0.06, 0.06, 2.5, 1.4, -0.5, 0), 0xb04a2a],
    [cyl(0.06, 0.06, 2.5, 1.4, 0.5, 0), 0xb04a2a], [box(3.0, 0.1, 0.1, 0, 0, 2.45), 0xb04a2a], [box(0.45, 0.18, 0.04, -0.6, 0, 0.5), 0x222222],
    [box(0.45, 0.18, 0.04, 0.6, 0, 0.5), 0x222222], [box(0.02, 0.02, 1.95, -0.6, 0, 1.47), 0x888888], [box(0.02, 0.02, 1.95, 0.6, 0, 1.47), 0x888888]]);
  const slideG = merge([[box(1.2, 1.2, 0.1, 0, 0, 1.5), 0x8a6a45], [box(0.08, 0.08, 1.5, -0.55, -0.55, 0.75), 0x8a6a45], [box(0.08, 0.08, 1.5, 0.55, -0.55, 0.75), 0x8a6a45],
    [box(0.08, 0.08, 1.5, -0.55, 0.55, 0.75), 0x8a6a45], [box(0.08, 0.08, 1.5, 0.55, 0.55, 0.75), 0x8a6a45],
    [box(2.6, 0.6, 0.06, 1.85, 0, 1.5), 0x2e6fb5], [box(0.5, 0.6, 1.4, -0.85, 0, 0.7), 0xd9b13a]]);
  const slideFix = slideG.clone(); { const p = slideFix.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i); if (x > 0.6) p.setZ(i, p.getZ(i) + (0.6 - x) * 0.5); } slideFix.computeVertexNormals(); }
  group.add(inst(swingG, vc, F.playgrounds, (p) => [V(p[0] - Math.min(p[3] * 0.18, 4), p[1], p[2]), 0, ONE]));
  group.add(inst(slideFix, vc, F.playgrounds, (p) => [V(p[0] + Math.min(p[3] * 0.18, 4), p[1] + 1, p[2]), 0.6, ONE]));

  root.add(group);
  // Lichtkarte (Laternen + Wartehäuschen)
  const extra = F.shelters.map((s) => [s[0], s[1], 5, '200,220,255', 0.35]);
  buildLampMap(F.lamps, bounds, lampTexSize, extra);

  // Ampelphasen (schematisch, nicht echt): Umlauf 60 s, je Knoten versetzt
  const RED = new THREE.Color(3.2, 0.25, 0.15), AMB = new THREE.Color(3.0, 1.5, 0.1), GRN = new THREE.Color(0.2, 3.0, 0.9), OFF = new THREE.Color(0.06, 0.06, 0.06);
  let lastSec = -1;
  function update(night, tSec) {
    glow.emissiveIntensity = 0.05 + 7 * night; adGlow.emissiveIntensity = 0.15 + 2.2 * night;
    const sec = Math.floor(tSec); if (sec === lastSec) return; lastSec = sec;
    lights.forEach(([s, k, n, i], j) => {
      const ph = (sec + i * 17 + (s[3] > 0 ? 30 : 0)) % 60; let on;
      if (n === 2) on = ph < 34 ? 0 : 1; else on = ph < 27 ? 0 : ph < 29 ? -1 : ph < 57 ? 2 : 1; // rot, rot-gelb, grün, gelb
      const c = n === 2 ? (k === on ? (k === 0 ? RED : GRN) : OFF) : (on === -1 ? (k < 2 ? (k === 0 ? RED : AMB) : OFF) : k === on ? [RED, AMB, GRN][k] : OFF);
      sigLights.setColorAt(j, c);
    });
    sigLights.instanceColor.needsUpdate = true;
  }
  update(0, 0);
  return { group, update, counts: Object.fromEntries(['lamps', 'benches', 'baskets', 'signals', 'stopsigns', 'shelters', 'playgrounds'].map((k) => [k, F[k].length])), lampsOsm: F.lamps_osm, lampsAdded: F.lamps_added, osmTs: F.osm_timestamp };
}
