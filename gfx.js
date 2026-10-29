// Riedberg 3D – Grafik: Qualitätsstufen, Nachbearbeitung (AO, Bloom, Kantenglättung), physikalischer Himmel, Laternen-Lichtkarte.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Sky } from 'three/addons/objects/Sky.js';

// Stufen: pr = max. Pixelverhältnis, shadow = Schattenkarte, shadowK = Größe des Schattenausschnitts relativ zum Blickabstand
export const QUALITY = {
  mobil:    { label: 'Mobil',    pr: 1,   composer: false, shadow: 1024, shadowK: 1.0, ao: false, bloom: false, smaa: false, msaa: 0, lampTex: 1024 },
  niedrig:  { label: 'Niedrig',  pr: 1,   composer: true,  shadow: 2048, shadowK: 1.0, ao: false, bloom: true,  smaa: true,  msaa: 0, lampTex: 2048 },
  standard: { label: 'Standard', pr: 1.5, composer: true,  shadow: 4096, shadowK: 0.9, ao: true,  bloom: true,  smaa: true,  msaa: 0, lampTex: 4096 },
  hoch:     { label: 'Hoch',     pr: 2,   composer: true,  shadow: 4096, shadowK: 0.65, ao: true, bloom: true,  smaa: false, msaa: 4, lampTex: 4096 },
};
const KEY = 'riedberg3d.quality';
export function initialQuality() {
  const q = new URLSearchParams(location.search).get('q') || localStorage.getItem(KEY);
  if (q && QUALITY[q]) return q;
  const mobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
  return mobile ? 'mobil' : 'standard';
}
export function saveQuality(q) { try { localStorage.setItem(KEY, q); } catch (e) { /* privat */ } }

// ---------- Nachbearbeitung ----------
export class Post {
  constructor(renderer, scene, camera) { Object.assign(this, { renderer, scene, camera }); this.q = null; this.composer = null; }
  setQuality(name) {
    const Q = QUALITY[name]; this.q = Q; this.name = name;
    const r = this.renderer; r.setPixelRatio(Math.min(devicePixelRatio, Q.pr));
    this.composer?.dispose(); this.composer = null; this.bloom = this.ao = null;
    if (!Q.composer) return;
    const w = innerWidth, h = innerHeight, pr = r.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: Q.msaa });
    const c = this.composer = new EffectComposer(r, rt); c.setPixelRatio(pr); c.setSize(w, h);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (Q.ao) {
      const ao = this.ao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
      ao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.5, thickness: 3, scale: 1.1, samples: name === 'hoch' ? 16 : 12, distanceFallOff: 1 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
      ao.blendIntensity = 0.85; c.addPass(ao);
    }
    if (Q.bloom) { this.bloom = new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.15, 0.5, 1.6); c.addPass(this.bloom); }
    c.addPass(new OutputPass());
    if (Q.smaa) c.addPass(new SMAAPass(w * pr, h * pr));
  }
  setSize(w, h) { if (this.composer) this.composer.setSize(w, h); }
  setNight(night) { // Bloom tagsüber nur für Sonnenreflexe, nachts für Laternen/Fenster/Signale
    if (!this.bloom) return;
    this.bloom.strength = 0.12 + 0.55 * night; this.bloom.threshold = 1.6 - 0.95 * night; this.bloom.radius = 0.45 + 0.2 * night;
  }
  render() { if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera); }
}

// ---------- Himmel: three.js Sky (Preetham) + Überlagerung für Bewölkung, Nacht und Sterne ----------
export function makeSky(scene) {
  const sky = new Sky(); sky.scale.setScalar(30000); sky.frustumCulled = false; sky.renderOrder = -11;
  const u = sky.material.uniforms; u.turbidity.value = 3; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
  u.uGain = { value: 1 };
  sky.material.onBeforeCompile = (sh) => { sh.uniforms.uGain = u.uGain;
    sh.fragmentShader = 'uniform float uGain;\n' + sh.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );', 'gl_FragColor = vec4( retColor * uGain, 1.0 );'); };
  scene.add(sky);
  const over = new THREE.Mesh(new THREE.SphereGeometry(29000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, transparent: true,
    uniforms: { uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunCol: { value: new THREE.Color(1, 0.95, 0.85) }, uSunVis: { value: 0 }, uStars: { value: 0 }, uA: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 uTop, uHor, uSunDir, uSunCol; uniform float uSunVis, uStars, uA; varying vec3 vDir;
      float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 col = mix(uHor, uTop, pow(clamp(h, 0.0, 1.0), 0.55)); if (h < 0.0) col = uHor * 0.92;
        float s = max(dot(d, normalize(uSunDir)), 0.0); col += uSunCol * uSunVis * (pow(s, 12.0) * 0.25);
        float a = uA;
        if (uStars > 0.0 && h > 0.05) { vec3 q = floor(d * 420.0); float st = step(0.9985, hash(q)) * uStars * (0.5 + 0.5 * hash(q + 3.0));
          col += vec3(st) * 1.6; a = max(a, min(st * 2.0, 1.0)); }
        gl_FragColor = vec4(col, a); }`,
  }));
  over.renderOrder = -10; over.frustumCulled = false; scene.add(over);
  return { sky, over };
}

// ---------- Laternen-Lichtkarte ----------
// Statt hunderter echter Lichtquellen: eine Draufsicht-Textur mit weichen Lichtkegeln je Laterne.
// Boden-, Straßen-, Möbel- und Fassadenshader lesen sie nach Weltposition und addieren Albedo × Licht × Nacht.
export const LAMP = { map: { value: null }, xf: { value: new THREE.Vector4(0, 0, 1, 1) }, night: { value: 0 }, gain: { value: 4.2 } };
export function buildLampMap(lamps, bounds, size, extra = []) {
  const [x0, y0, x1, y1] = bounds, c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, size, size); g.globalCompositeOperation = 'lighter';
  const sx = size / (x1 - x0), sy = size / (y1 - y0);
  const blob = (x, y, r, rgb, a) => {
    const px = (x - x0) * sx, py = (y1 - y) * sy, pr = Math.max(r * sx, 1.5);
    const gr = g.createRadialGradient(px, py, 0, px, py, pr);
    gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(0.35, `rgba(${rgb},${a * 0.55})`); gr.addColorStop(0.7, `rgba(${rgb},${a * 0.15})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  };
  for (const [x, y, , h, rot] of lamps) { // Lichtpunkt 0,9 m vom Mast zur Fahrbahn (Ausleger)
    const cx = x + Math.cos(rot) * 0.9, cy = y + Math.sin(rot) * 0.9;
    blob(cx, cy, h * 3.0, '255,200,140', 0.5);
  }
  for (const [x, y, r, rgb, a] of extra) blob(x, y, r, rgb, a);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.flipY = true; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4;
  LAMP.map.value = t; LAMP.xf.value.set(x0, y0, 1 / (x1 - x0), 1 / (y1 - y0));
  return t;
}
// in beliebige Standard-Materialien einhängen (verkettet mit bestehendem onBeforeCompile).
// fall: GLSL-Ausdruck für Höhenabfall (z. B. Fassaden), Standard 1.0
export function withLampLight(mat, fall = '1.0', vary = '') {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, { uLampMap: LAMP.map, uLampXf: LAMP.xf, uLampNight: LAMP.night, uLampGain: LAMP.gain });
    sh.vertexShader = 'varying vec3 vLampW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      { vec4 lw = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        lw = instanceMatrix * lw;
      #endif
        vLampW = (modelMatrix * lw).xyz; }`);
    sh.fragmentShader = 'uniform sampler2D uLampMap; uniform vec4 uLampXf; uniform float uLampNight, uLampGain; varying vec3 vLampW;\n' + vary + sh.fragmentShader
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      if (uLampNight > 0.01) { vec2 luv = (vec2(vLampW.x, -vLampW.z) - uLampXf.xy) * uLampXf.zw;
        vec3 lampL = texture2D(uLampMap, luv).rgb; lampL *= 0.35 + 0.65 * lampL;
        totalEmissiveRadiance += diffuseColor.rgb * lampL * uLampNight * uLampGain * (${fall}); }`);
  };
  const pk = (prev ? prev.toString() : '') + '|lamp|' + fall + vary;
  mat.customProgramCacheKey = () => pk;
  return mat;
}
