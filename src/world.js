import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeNoise2D, mulberry32, clamp, lerp, smoothstep } from './noise.js';

// ---- Road / world constants ----
export const ROAD_HALF = 3.7;            // asphalt half width (2 lanes)
export const SHOULDER = 1.4;             // paved shoulder
export const EDGE = 0.9;                 // gravel edge
export const ROAD_W = ROAD_HALF + SHOULDER + EDGE;
export const LANE = 1.85;                // lane centre offset
export const STEP = 4;                   // road sample spacing (m)
export const WATER_LEVEL = 0;
const CELL = 52;
export const CHUNK = 160;
const BLOCK = 48;                        // road points per mesh block
const SMOOTH_W = 30;

const lin = (c) => Math.pow(c, 2.2);

// Shared GLSL helpers (periodic value noise to stay precise at big coordinates)
const GLSL_NOISE = /* glsl */ `
varying vec3 vWPos;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float pnoise(vec2 x, float per){
  vec2 i = floor(x); vec2 f = fract(x); f = f*f*(3.0-2.0*f);
  vec2 i1 = mod(i, per), i2 = mod(i + 1.0, per);
  float a = hash12(i1), b = hash12(vec2(i2.x, i1.y)), c = hash12(vec2(i1.x, i2.y)), d = hash12(i2);
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}`;

export class World {
  constructor(seed, scene, quality) {
    this.seed = seed;
    this.scene = scene;
    this.quality = quality;
    const r = mulberry32(seed * 7 + 13);
    this.nC = makeNoise2D(seed + 1);
    this.nH = makeNoise2D(seed + 2);
    this.nR = makeNoise2D(seed + 3);
    this.nM = makeNoise2D(seed + 4);
    this.nB = makeNoise2D(seed + 5);
    this.nRoad = makeNoise2D(seed + 6);
    this.nF = makeNoise2D(seed + 7);

    // pick a world offset so that the start is on land
    for (let k = 0; k < 200; k++) {
      this.ox = (r() - 0.5) * 2e5; this.oz = (r() - 0.5) * 2e5;
      const h = this.baseHeight(0, 0);
      if (h > 6 && h < 45) break;
    }

    // road data
    this.rx = []; this.rz = []; this.rawH = []; this.rh = []; this.hd = [];
    this.heading = 0; this.turn = 0; this.avoid = 0; this.avoidT = 0;
    this.hash = new Map();
    this.q = { found: false, d: 0, i: 0, t: 0, lat: 0, h: 0 };
    this.lastD = 1e9;
    this.weights = [];
    for (let k = -SMOOTH_W; k <= SMOOTH_W; k++) this.weights.push(Math.exp(-(k * k) / (2 * (SMOOTH_W * 0.45) ** 2)));

    this.chunks = new Map();
    this.roadBlocks = new Map();
    this.buildQueue = [];

    this._makeMaterials();
    this._makeTreeGeometries();
  }

  // ---------------- terrain height ----------------
  baseHeight(x, z) {
    x += this.ox; z += this.oz;
    const c = this.nC(x * 0.00032, z * 0.00032) * 0.65 + this.nC(x * 0.0009 + 31, z * 0.0009 - 17) * 0.35;
    let h = 16 + c * 52;
    let a = 1, f = 0.0024, hs = 0;
    for (let o = 0; o < 4; o++) { hs += this.nH(x * f, z * f) * a; a *= 0.5; f *= 2.03; }
    h += hs * 20;
    const mm = smoothstep(-0.1, 0.55, this.nM(x * 0.00026 + 50, z * 0.00026 - 80));
    if (mm > 0) {
      let rr = 0, w = 1; a = 1; f = 0.0011;
      for (let o = 0; o < 5; o++) {
        let n = 1 - Math.abs(this.nR(x * f, z * f)); n *= n; n *= w;
        w = clamp(n * 1.3, 0, 1); rr += n * a; a *= 0.5; f *= 2.1;
      }
      h += rr * 210 * mm;
    }
    h += this.nH(x * 0.031 + 7, z * 0.031) * 0.5;
    return h;
  }

  forest(x, z) {
    x += this.ox; z += this.oz;
    const f = this.nF(x * 0.0032, z * 0.0032) * 0.7 + this.nF(x * 0.014, z * 0.014) * 0.3;
    return smoothstep(0.0, 0.45, f);
  }

  // ---------------- road generation ----------------
  _genPoint() {
    const n = this.rx.length;
    if (n === 0) {
      this.rx.push(0); this.rz.push(0); this.hd.push(0);
      this.rawH.push(Math.max(this.baseHeight(0, 0), 3.5));
      return;
    }
    const x0 = this.rx[n - 1], z0 = this.rz[n - 1];
    const s = n * STEP;
    let target = 0.95 * this.nRoad(s * 0.0009, 0.37) + 0.45 * this.nRoad(s * 0.0037, 5.3);
    if (n % 2 === 0) {
      const L = 85, h0 = this.baseHeight(x0, z0);
      const cost = (ang) => {
        const sx = Math.sin(ang), cz = Math.cos(ang);
        let c = 0;
        for (let k = 1; k <= 3; k++) {
          const hh = this.baseHeight(x0 + sx * L * k, z0 + cz * L * k);
          c += Math.abs(hh - h0) / k;
          if (hh < 2) c += 20 / k;
        }
        return c;
      };
      const cl = cost(this.heading - 0.45), cr = cost(this.heading + 0.45);
      this.avoidT = clamp((cl - cr) * 0.02, -0.85, 0.85);
    }
    this.avoid = lerp(this.avoid, this.avoidT, 0.04);
    target = clamp(target + this.avoid, -1.15, 1.15);
    const dh = clamp((target - this.heading) * 0.09, -0.042, 0.042);
    this.turn = lerp(this.turn, dh, 0.2);
    this.heading += this.turn;
    const x = x0 + Math.sin(this.heading) * STEP;
    const z = z0 + Math.cos(this.heading) * STEP;
    this.rx.push(x); this.rz.push(z); this.hd.push(this.heading);
    this.rawH.push(Math.max(this.baseHeight(x, z), 3.5));
  }

  _finalize() {
    const raw = this.rawH, W = SMOOTH_W;
    while (this.rh.length < raw.length - W) {
      const i = this.rh.length;
      let sum = 0, ws = 0;
      for (let k = -W; k <= W; k++) {
        const j = clamp(i + k, 0, raw.length - 1);
        const w = this.weights[k + W];
        sum += raw[j] * w; ws += w;
      }
      let h = sum / ws;
      if (i > 0) { const p = this.rh[i - 1]; h = clamp(h, p - STEP * 0.105, p + STEP * 0.105); }
      this.rh.push(h);
      if (i > 0) this._hashSeg(i - 1);
    }
  }

  _key(cx, cz) { return (cx + 100000) * 200003 + (cz + 100000); }
  _hashSeg(i) {
    const k1 = this._key(Math.floor(this.rx[i] / CELL), Math.floor(this.rz[i] / CELL));
    const k2 = this._key(Math.floor(this.rx[i + 1] / CELL), Math.floor(this.rz[i + 1] / CELL));
    let a = this.hash.get(k1); if (!a) { a = []; this.hash.set(k1, a); } a.push(i);
    if (k2 !== k1) { let b = this.hash.get(k2); if (!b) { b = []; this.hash.set(k2, b); } b.push(i); }
  }

  ensureRoad(zAhead) {
    let guard = 0;
    while ((this.rz.length === 0 || this.rz[this.rz.length - 1] < zAhead + SMOOTH_W * STEP + 50) && guard++ < 20000) this._genPoint();
    this._finalize();
  }
  get finalCount() { return this.rh.length; }
  get finalZ() { return this.rh.length ? this.rz[this.rh.length - 1] : -1e9; }

  // nearest finalized road segment
  roadQuery(x, z) {
    const q = this.q; q.found = false;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let best = 1e18;
    const rx = this.rx, rz = this.rz;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.hash.get(this._key(cx + dx, cz + dz));
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        const ax = rx[i], az = rz[i];
        const abx = rx[i + 1] - ax, abz = rz[i + 1] - az;
        const l2 = abx * abx + abz * abz;
        let t = ((x - ax) * abx + (z - az) * abz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + abx * t - x, pz = az + abz * t - z;
        const d2 = px * px + pz * pz;
        if (d2 < best) { best = d2; q.i = i; q.t = t; }
      }
    }
    if (best === 1e18) return q;
    q.found = true;
    q.d = Math.sqrt(best);
    const i = q.i;
    q.h = lerp(this.rh[i], this.rh[i + 1], q.t);
    const abx = rx[i + 1] - rx[i], abz = rz[i + 1] - rz[i];
    const L = Math.hypot(abx, abz);
    // right vector = (-fz, 0, fx)
    const px = x - (rx[i] + abx * q.t), pz = z - (rz[i] + abz * q.t);
    q.lat = (px * (-abz / L) + pz * (abx / L));
    return q;
  }

  heightAt(x, z) {
    const b = this.baseHeight(x, z);
    const q = this.roadQuery(x, z);
    if (!q.found) { this.lastD = 1e9; return b; }
    this.lastD = q.d;
    const inner = ROAD_HALF + SHOULDER + 0.3;
    const target = q.h - 0.12;
    if (q.d <= inner) return target;
    const diff = Math.abs(b - target);
    const width = Math.min(5 + diff * 1.8, CELL - inner - 2);
    if (q.d >= inner + width) return b;
    return lerp(target, b, smoothstep(inner, inner + width, q.d));
  }

  // drivable surface height (road if on it, otherwise terrain)
  groundAt(x, z) {
    const h = this.heightAt(x, z);
    const q = this.q;
    if (q.found && q.d < ROAD_HALF + SHOULDER + 0.2) {
      const crown = 0.05 * (1 - Math.min(1, Math.abs(q.lat) / ROAD_HALF));
      return q.h + crown;
    }
    return Math.max(h, WATER_LEVEL - 1.2);
  }

  // locate along the road using a local search window (fast, for the car)
  locate(x, z, hint) {
    const n = this.rh.length - 1;
    let best = 1e18, bi = 0, bt = 0;
    const a = clamp(hint - 40, 0, n - 1), e = clamp(hint + 40, 0, n - 1);
    for (let i = a; i < e; i++) {
      const ax = this.rx[i], az = this.rz[i];
      const abx = this.rx[i + 1] - ax, abz = this.rz[i + 1] - az;
      let t = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz);
      t = clamp(t, 0, 1);
      const px = ax + abx * t - x, pz = az + abz * t - z;
      const d2 = px * px + pz * pz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    return { i: bi, t: bt, d: Math.sqrt(best) };
  }

  // interpolated road sample at fractional index
  sample(f, out) {
    const n = this.rh.length - 2;
    f = clamp(f, 0, n);
    const i = Math.floor(f), t = f - i;
    out.x = lerp(this.rx[i], this.rx[i + 1], t);
    out.z = lerp(this.rz[i], this.rz[i + 1], t);
    out.y = lerp(this.rh[i], this.rh[i + 1], t);
    const dx = this.rx[i + 1] - this.rx[i], dz = this.rz[i + 1] - this.rz[i];
    const L = Math.hypot(dx, dz);
    out.fx = dx / L; out.fz = dz / L;
    out.heading = Math.atan2(dx, dz);
    return out;
  }

  curvatureAhead(i, dist) {
    let m = 0;
    const n = this.hd.length - 3;
    const steps = Math.floor(dist / STEP);
    for (let k = 0; k < steps; k += 2) {
      const j = Math.min(i + k, n);
      const c = Math.abs(this.hd[j + 2] - this.hd[j]) / (2 * STEP);
      // closer curves count fully, far curves less
      m = Math.max(m, c * (1 - (k / steps) * 0.4));
    }
    return m;
  }

  // ---------------- colours ----------------
  groundColor(x, z, h, ny, d, out) {
    const wx = x + this.ox, wz = z + this.oz;
    const dry = this.nB(wx * 0.00045, wz * 0.00045);
    const v = this.nB(wx * 0.012 + 3, wz * 0.012 - 8) * 0.5 + this.nB(wx * 0.05, wz * 0.05) * 0.25;
    const t = smoothstep(-0.25, 0.75, dry + v * 0.35);
    let r = lerp(0.25, 0.58, t), g = lerp(0.42, 0.52, t), b = lerp(0.12, 0.24, t);
    // flowers / patches of yellow-green
    const p = smoothstep(0.35, 0.6, v);
    r = lerp(r, r * 1.25, p); g = lerp(g, g * 1.1, p);
    const fo = this.forest(x, z);
    const fd = 1 - 0.38 * fo * smoothstep(140, 100, h);
    r *= fd; g *= fd; b *= fd;
    // rock
    let rock = smoothstep(0.8, 0.62, ny) + smoothstep(115, 160, h) * 0.6;
    rock = clamp(rock + v * 0.2, 0, 1);
    const rc = 0.42 + v * 0.1;
    r = lerp(r, rc * 1.02, rock); g = lerp(g, rc * 0.97, rock); b = lerp(b, rc * 0.92, rock);
    // sand near water
    const sand = 1 - smoothstep(1.4, 3.4, h + v * 1.6);
    r = lerp(r, 0.74, sand); g = lerp(g, 0.67, sand); b = lerp(b, 0.5, sand);
    // underwater
    const uw = smoothstep(0, -4, h);
    r = lerp(r, 0.35, uw); g = lerp(g, 0.34, uw); b = lerp(b, 0.26, uw);
    // snow
    const snow = smoothstep(155, 185, h + v * 25) * smoothstep(0.55, 0.78, ny);
    r = lerp(r, 0.93, snow); g = lerp(g, 0.95, snow); b = lerp(b, 0.99, snow);
    // gravel near road
    const gr = 1 - smoothstep(ROAD_W - 0.4, ROAD_W + 2.5, d);
    r = lerp(r, 0.46, gr); g = lerp(g, 0.43, gr); b = lerp(b, 0.38, gr);
    out[0] = lin(r); out[1] = lin(g); out[2] = lin(b);
    out[3] = (1 - rock) * (1 - sand) * (1 - snow) * (1 - gr) * (1 - uw); // grassiness
    return out;
  }

  // ---------------- materials ----------------
  _makeMaterials() {
    const uniforms = this.sharedUniforms = { uTime: { value: 0 } };

    const tm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
    tm.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <project_vertex>', 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GLSL_NOISE)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 wp = mod(vWPos.xz, 1000.0);
          float n1 = pnoise(wp * 0.4, 400.0);
          float n2 = pnoise(wp * 2.3, 2300.0);
          float n3 = pnoise(wp * 0.05, 50.0);
          float n4 = pnoise(wp * 9.0, 9000.0);
          diffuseColor.rgb *= 0.8 + 0.22 * n1 + 0.12 * n2 + 0.22 * (n3 - 0.5) + 0.08 * n4;`);
    };
    this.terrainMat = tm;

    // road texture
    const W = 512, Hh = 1024, span = ROAD_W * 2;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
    const g = cv.getContext('2d');
    const px = (m) => ((m + ROAD_W) / span) * W;
    const pv = (m) => (m / 16) * Hh;
    g.fillStyle = '#6d665c'; g.fillRect(0, 0, W, Hh);
    g.fillStyle = '#3b3b3d'; g.fillRect(px(-ROAD_HALF - SHOULDER), 0, px(ROAD_HALF + SHOULDER) - px(-ROAD_HALF - SHOULDER), Hh);
    g.fillStyle = '#323234'; g.fillRect(px(-ROAD_HALF), 0, px(ROAD_HALF) - px(-ROAD_HALF), Hh);
    // tyre wear
    for (const c of [-LANE - 0.8, -LANE + 0.8, LANE - 0.8, LANE + 0.8]) {
      const grd = g.createLinearGradient(px(c - 0.5), 0, px(c + 0.5), 0);
      grd.addColorStop(0, 'rgba(20,20,22,0)'); grd.addColorStop(0.5, 'rgba(20,20,22,0.35)'); grd.addColorStop(1, 'rgba(20,20,22,0)');
      g.fillStyle = grd; g.fillRect(px(c - 0.5), 0, px(c + 0.5) - px(c - 0.5), Hh);
    }
    // grain
    const img = g.getImageData(0, 0, W, Hh); const dd = img.data; const rnd = mulberry32(99);
    for (let i = 0; i < dd.length; i += 4) {
      const n = (rnd() - 0.5) * 34 + ((rnd() < 0.02) ? 30 : 0);
      dd[i] = clamp(dd[i] + n, 0, 255); dd[i + 1] = clamp(dd[i + 1] + n, 0, 255); dd[i + 2] = clamp(dd[i + 2] + n, 0, 255);
    }
    g.putImageData(img, 0, 0);
    // gravel stones at edges
    for (let k = 0; k < 2500; k++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const m = side * (ROAD_HALF + SHOULDER + rnd() * EDGE);
      const c = 80 + rnd() * 90 | 0;
      g.fillStyle = `rgb(${c},${c * 0.95 | 0},${c * 0.88 | 0})`;
      g.fillRect(px(m), rnd() * Hh, 2 + rnd() * 3, 2 + rnd() * 3);
    }
    // lines
    g.fillStyle = 'rgba(236,236,228,0.92)';
    const lw = px(0.15) - px(0);
    g.fillRect(px(-ROAD_HALF + 0.1), 0, lw, Hh);
    g.fillRect(px(ROAD_HALF - 0.25), 0, lw, Hh);
    g.fillStyle = 'rgba(240,196,40,0.95)';
    g.fillRect(px(-0.18), pv(0), lw, pv(5));
    g.fillRect(px(-0.18), pv(8), lw, pv(5));
    g.fillRect(px(0.03), pv(0), lw, pv(5));
    g.fillRect(px(0.03), pv(8), lw, pv(5));
    // crack-ish speckle over lines for wear
    for (let k = 0; k < 4000; k++) { g.fillStyle = `rgba(40,40,40,${rnd() * 0.35})`; g.fillRect(rnd() * W, rnd() * Hh, 1.5, 1.5); }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    this.roadTex = tex;
    this.roadMat = new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.82, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });

    // trees / grass with wind
    const windify = (mat, amp, base) => {
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = uniforms.uTime;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec2 ip = instanceMatrix[3].xz;
            #else
              vec2 ip = vec2(0.0);
            #endif
            float wk = max(position.y - ${base.toFixed(2)}, 0.0);
            float ph = uTime * 1.6 + ip.x * 0.07 + ip.y * 0.05;
            transformed.x += (sin(ph) * 0.6 + sin(ph * 2.3 + 1.3) * 0.25) * ${amp.toFixed(3)} * wk;
            transformed.z += (cos(ph * 0.8) * 0.4) * ${amp.toFixed(3)} * wk;`);
      };
    };
    this.treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    windify(this.treeMat, 0.018, 1.5);
    this.grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    windify(this.grassMat, 0.22, 0.0);
    this.rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
    this.postMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
    this.reflMat = new THREE.MeshStandardMaterial({ color: 0xff7a00, emissive: 0xff5500, emissiveIntensity: 0.6, roughness: 0.3 });
  }

  _makeTreeGeometries() {
    const colorize = (geo, c, darkenBottom = 0) => {
      geo = geo.index ? geo.toNonIndexed() : geo;
      const n = geo.attributes.position.count; const arr = new Float32Array(n * 3);
      const p = geo.attributes.position;
      let minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) { minY = Math.min(minY, p.getY(i)); maxY = Math.max(maxY, p.getY(i)); }
      for (let i = 0; i < n; i++) {
        const k = darkenBottom ? lerp(1 - darkenBottom, 1, (p.getY(i) - minY) / (maxY - minY + 1e-6)) : 1;
        arr[i * 3] = lin(c[0]) * k; arr[i * 3 + 1] = lin(c[1]) * k; arr[i * 3 + 2] = lin(c[2]) * k;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      geo.deleteAttribute('uv');
      return geo;
    };
    const jitter = (geo, amt, seed) => {
      const r = mulberry32(seed); const p = geo.attributes.position;
      const map = new Map();
      for (let i = 0; i < p.count; i++) {
        const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
        let o = map.get(key);
        if (!o) { o = [(r() - 0.5) * amt, (r() - 0.5) * amt, (r() - 0.5) * amt]; map.set(key, o); }
        p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
      }
      geo.computeVertexNormals();
      return geo;
    };
    const trunkC = [0.36, 0.25, 0.17];
    // pine
    {
      const parts = [];
      const trunk = new THREE.CylinderGeometry(0.16, 0.28, 3.2, 6); trunk.translate(0, 0.6, 0);
      parts.push(colorize(trunk, trunkC));
      const layers = [[2.4, 3.6, 2.2], [1.95, 3.2, 3.8], [1.45, 2.8, 5.3], [0.9, 2.3, 6.7]];
      layers.forEach(([rad, hgt, y], k) => {
        const c = new THREE.ConeGeometry(rad, hgt, 8, 1); c.translate(0, y, 0);
        const cg = jitter(c.toNonIndexed(), 0.35, 11 + k);
        parts.push(colorize(cg, [0.11, 0.24, 0.12], 0.45));
      });
      this.pineGeo = mergeGeometries(parts);
    }
    // broadleaf
    {
      const parts = [];
      const trunk = new THREE.CylinderGeometry(0.18, 0.32, 3.6, 6); trunk.translate(0, 0.8, 0);
      parts.push(colorize(trunk, trunkC));
      const blobs = [[0, 4.6, 0, 2.1], [1.1, 3.9, 0.4, 1.5], [-0.9, 4.0, -0.5, 1.6], [0.2, 5.6, -0.3, 1.5], [-0.3, 4.2, 1.0, 1.4]];
      blobs.forEach(([x, y, z, rr], k) => {
        const s = new THREE.IcosahedronGeometry(rr, 1); s.translate(x, y, z);
        parts.push(colorize(jitter(s, 0.45, 40 + k), [0.2, 0.36, 0.12], 0.4));
      });
      this.leafGeo = mergeGeometries(parts);
    }
    // birch-ish slim tree
    {
      const parts = [];
      const trunk = new THREE.CylinderGeometry(0.1, 0.16, 6, 5); trunk.translate(0, 2.4, 0);
      parts.push(colorize(trunk, [0.85, 0.83, 0.78]));
      const blobs = [[0, 5.2, 0, 1.3], [0.5, 4.3, 0.2, 1.0], [-0.4, 6.0, -0.2, 0.9], [-0.3, 4.6, 0.5, 0.9]];
      blobs.forEach(([x, y, z, rr], k) => {
        const s = new THREE.IcosahedronGeometry(rr, 1); s.translate(x, y, z);
        parts.push(colorize(jitter(s, 0.35, 70 + k), [0.42, 0.52, 0.18], 0.35));
      });
      this.birchGeo = mergeGeometries(parts);
    }
    // rock
    {
      const s = new THREE.IcosahedronGeometry(1, 1);
      s.scale(1.3, 0.75, 1.0);
      this.rockGeo = colorize(jitter(s.toNonIndexed(), 0.5, 5), [0.5, 0.48, 0.45], 0.3);
    }
    // grass tuft
    {
      const r = mulberry32(3);
      const pos = [], col = [], nor = [];
      for (let b = 0; b < 6; b++) {
        const a = r() * Math.PI * 2, off = r() * 0.25;
        const bx = Math.cos(a) * off, bz = Math.sin(a) * off;
        const w = 0.05 + r() * 0.04, h = 0.35 + r() * 0.45;
        const ra = r() * Math.PI;
        const cx = Math.cos(ra) * w, cz = Math.sin(ra) * w;
        const lean = (r() - 0.5) * 0.3;
        pos.push(bx - cx, 0, bz - cz, bx + cx, 0, bz + cz, bx + lean, h, bz + lean * 0.5);
        col.push(0.45, 0.45, 0.45, 0.45, 0.45, 0.45, 1.15, 1.15, 1.0);
        nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      }
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      gg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      gg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.grassGeo = gg;
    }
    // delineator post + reflector
    this.postGeo = new THREE.BoxGeometry(0.1, 1.0, 0.1); this.postGeo.translate(0, 0.5, 0);
    this.reflGeo = new THREE.BoxGeometry(0.11, 0.14, 0.11); this.reflGeo.translate(0, 0.86, 0);
  }

  // ---------------- terrain chunk ----------------
  _buildChunk(cx, cz, segs, detail) {
    const n = segs + 1, step = CHUNK / segs, N = n + 2;
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const H = new Float32Array(N * N), D = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ox + (i - 1) * step, z = oz + (j - 1) * step;
      H[j * N + i] = this.heightAt(x, z);
      D[j * N + i] = this.lastD;
    }
    const vc = n * n + 4 * n;
    const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3);
    const grassy = new Float32Array(n * n), NY = new Float32Array(n * n);
    const c4 = [0, 0, 0, 0];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gi = (j + 1) * N + (i + 1), v = j * n + i;
      const h = H[gi];
      let nx = (H[gi - 1] - H[gi + 1]) / (2 * step), nz = (H[gi - N] - H[gi + N]) / (2 * step), ny = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      pos[v * 3] = i * step; pos[v * 3 + 1] = h; pos[v * 3 + 2] = j * step;
      nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
      this.groundColor(ox + i * step, oz + j * step, h, ny, D[gi], c4);
      col[v * 3] = c4[0]; col[v * 3 + 1] = c4[1]; col[v * 3 + 2] = c4[2];
      grassy[v] = c4[3]; NY[v] = ny;
    }
    // skirts
    const edges = [];
    for (let i = 0; i < n; i++) edges.push(i);                       // j=0
    for (let i = 0; i < n; i++) edges.push((n - 1) * n + i);         // j=n-1
    for (let j = 0; j < n; j++) edges.push(j * n);                   // i=0
    for (let j = 0; j < n; j++) edges.push(j * n + n - 1);           // i=n-1
    const drop = Math.max(3, step * 1.5);
    for (let k = 0; k < edges.length; k++) {
      const s = edges[k], v = n * n + k;
      pos[v * 3] = pos[s * 3]; pos[v * 3 + 1] = pos[s * 3 + 1] - drop; pos[v * 3 + 2] = pos[s * 3 + 2];
      nor[v * 3] = nor[s * 3]; nor[v * 3 + 1] = nor[s * 3 + 1]; nor[v * 3 + 2] = nor[s * 3 + 2];
      col[v * 3] = col[s * 3]; col[v * 3 + 1] = col[s * 3 + 1]; col[v * 3 + 2] = col[s * 3 + 2];
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    for (let e = 0; e < 4; e++) for (let k = 0; k < n - 1; k++) {
      const a = edges[e * n + k], b = edges[e * n + k + 1];
      const sa = n * n + e * n + k, sb = sa + 1;
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(vc > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();

    const group = new THREE.Group();
    group.add(mesh);

    if (detail >= 1) this._scatter(group, cx, cz, n, step, pos, grassy, NY, col, D, N, detail);
    return group;
  }

  _scatter(group, cx, cz, n, step, pos, grassy, NY, col, D, N, detail) {
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const r = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ this.seed);
    const sampleIdx = (lx, lz) => {
      const i = clamp(Math.round(lx / step), 0, n - 1), j = clamp(Math.round(lz / step), 0, n - 1);
      return j * n + i;
    };
    const hAt = (lx, lz) => {
      const fx = clamp(lx / step, 0, n - 1.001), fz = clamp(lz / step, 0, n - 1.001);
      const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
      const a = pos[(j * n + i) * 3 + 1], b = pos[(j * n + i + 1) * 3 + 1];
      const c = pos[((j + 1) * n + i) * 3 + 1], d = pos[((j + 1) * n + i + 1) * 3 + 1];
      return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
    };
    const roadD = (lx, lz) => {
      const i = clamp(Math.round(lx / step), 0, n - 1), j = clamp(Math.round(lz / step), 0, n - 1);
      return D[(j + 1) * N + (i + 1)];
    };
    const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), tilt = new THREE.Euler();
    const cA = new THREE.Color();

    const lists = { pine: [], leaf: [], birch: [], rock: [] };
    const cand = detail >= 2 ? 1400 : 900;
    for (let k = 0; k < cand; k++) {
      const lx = r() * CHUNK, lz = r() * CHUNK;
      const x = ox + lx, z = oz + lz;
      const fo = this.forest(x, z);
      const roll = r();
      const vi = sampleIdx(lx, lz);
      const h = hAt(lx, lz), ny = NY[vi];
      const rd = roadD(lx, lz);
      if (rd < ROAD_W + 3.5 || h < 2.2) continue;
      if (roll < 0.02 && ny > 0.7 && h > 1) { lists.rock.push([lx, h, lz, r()]); continue; }
      if (roll > fo * 0.95 + 0.02) continue;
      if (ny < 0.78 || h > 150) continue;
      const alt = smoothstep(40, 110, h);
      const dry = this.nB((x + this.ox) * 0.00045, (z + this.oz) * 0.00045);
      const pick = r();
      if (pick < 0.25 + alt * 0.6) lists.pine.push([lx, h, lz, r()]);
      else if (pick < 0.85 - dry * 0.25) lists.leaf.push([lx, h, lz, r()]);
      else lists.birch.push([lx, h, lz, r()]);
    }
    const make = (geo, mat, arr, sMin, sMax, tint, shadow) => {
      if (!arr.length) return;
      const im = new THREE.InstancedMesh(geo, mat, arr.length);
      for (let k = 0; k < arr.length; k++) {
        const [lx, h, lz, rr] = arr[k];
        const s = lerp(sMin, sMax, rr);
        tilt.set((rr - 0.5) * 0.08, rr * 40, (rr * 7 % 1 - 0.5) * 0.08);
        qq.setFromEuler(tilt);
        sc.set(s, s * lerp(0.85, 1.2, (rr * 13) % 1), s);
        pp.set(ox + lx, h - 0.15, oz + lz);
        m4.compose(pp, qq, sc);
        im.setMatrixAt(k, m4);
        const t = tint((rr * 31) % 1);
        cA.setRGB(t[0], t[1], t[2]);
        im.setColorAt(k, cA);
      }
      im.castShadow = shadow; im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      group.add(im);
    };
    const shadows = this.quality.shadows;
    make(this.pineGeo, this.treeMat, lists.pine, 0.8, 1.6, (t) => [lerp(0.8, 1.2, t), lerp(0.85, 1.15, t), 0.9], shadows);
    make(this.leafGeo, this.treeMat, lists.leaf, 0.75, 1.4, (t) => [lerp(0.8, 1.5, t), lerp(0.9, 1.25, t), lerp(0.7, 1.0, t)], shadows);
    make(this.birchGeo, this.treeMat, lists.birch, 0.8, 1.3, (t) => [lerp(0.9, 1.4, t), lerp(0.9, 1.15, t), 0.9], shadows);
    make(this.rockGeo, this.rockMat, lists.rock, 0.3, 1.5, (t) => [lerp(0.8, 1.15, t), lerp(0.8, 1.1, t), lerp(0.8, 1.05, t)], shadows);

    // grass
    if (detail >= 2 && this.quality.grass) {
      const G = [];
      const count = this.quality.grassCount;
      for (let k = 0; k < count; k++) {
        const lx = r() * CHUNK, lz = r() * CHUNK;
        const vi = sampleIdx(lx, lz);
        const gs = grassy[vi];
        if (gs < 0.4 || r() > gs) continue;
        if (roadD(lx, lz) < ROAD_W + 0.6) continue;
        const h = hAt(lx, lz);
        if (h < 1.5) continue;
        G.push([lx, h, lz, r(), vi]);
      }
      if (G.length) {
        const im = new THREE.InstancedMesh(this.grassGeo, this.grassMat, G.length);
        for (let k = 0; k < G.length; k++) {
          const [lx, h, lz, rr, vi] = G[k];
          const s = lerp(0.7, 1.6, rr);
          qq.setFromAxisAngle(up, rr * 50);
          sc.set(s, s * lerp(0.7, 1.4, (rr * 17) % 1), s);
          pp.set(ox + lx, h - 0.05, oz + lz);
          m4.compose(pp, qq, sc);
          im.setMatrixAt(k, m4);
          // convert linear terrain colour -> tint (grassMat uses vertex color gradient)
          const b = 1.25 + ((rr * 7) % 1) * 0.35;
          cA.setRGB(col[vi * 3] * b, col[vi * 3 + 1] * b, col[vi * 3 + 2] * b);
          im.setColorAt(k, cA);
        }
        im.receiveShadow = true; im.castShadow = false;
        im.computeBoundingSphere();
        group.add(im);
      }
    }
  }

  // ---------------- road mesh ----------------
  _buildRoadBlock(b) {
    const i0 = b * BLOCK, i1 = Math.min(i0 + BLOCK, this.rh.length - 2);
    const ox = this.rx[i0], oz = this.rz[i0];
    const cols = [[-ROAD_W, -0.45], [-ROAD_HALF - SHOULDER, -0.02], [-ROAD_HALF, 0], [0, 0.05], [ROAD_HALF, 0], [ROAD_HALF + SHOULDER, -0.02], [ROAD_W, -0.45]];
    const C = cols.length;
    const pos = [], uv = [], idx = [];
    for (let i = i0; i <= i1; i++) {
      const a = Math.max(i - 1, 0), c = i + 1;
      let fx = this.rx[c] - this.rx[a], fz = this.rz[c] - this.rz[a];
      const L = Math.hypot(fx, fz); fx /= L; fz /= L;
      const rxv = -fz, rzv = fx;
      for (let k = 0; k < C; k++) {
        const [lat, dy] = cols[k];
        pos.push(this.rx[i] + rxv * lat - ox, this.rh[i] + dy, this.rz[i] + rzv * lat - oz);
        uv.push((lat + ROAD_W) / (2 * ROAD_W), (i * STEP) / 16);
      }
    }
    const rows = i1 - i0 + 1;
    for (let r = 0; r < rows - 1; r++) for (let k = 0; k < C - 1; k++) {
      const a = r * C + k, bb = a + 1, c = a + C, d = c + 1;
      // forward is +row; right is +k. Upward-facing winding:
      idx.push(a, bb, c, bb, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.roadMat);
    mesh.position.set(ox, 0, oz);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    const group = new THREE.Group();
    group.add(mesh);

    // delineator posts every 48m on both sides
    const posts = [];
    for (let i = i0; i < i1; i += 12) {
      const c = i + 1;
      let fx = this.rx[c] - this.rx[i], fz = this.rz[c] - this.rz[i];
      const L = Math.hypot(fx, fz); fx /= L; fz /= L;
      for (const s of [-1, 1]) {
        const lat = s * (ROAD_HALF + SHOULDER + 0.45);
        posts.push([this.rx[i] - fz * lat, this.rh[i] - 0.05, this.rz[i] + fx * lat, Math.atan2(fx, fz)]);
      }
    }
    if (posts.length) {
      const pm = new THREE.InstancedMesh(this.postGeo, this.postMat, posts.length);
      const rm = new THREE.InstancedMesh(this.reflGeo, this.reflMat, posts.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      posts.forEach(([x, y, z, a], k) => { q.setFromAxisAngle(up, a); p.set(x, y, z); m4.compose(p, q, s); pm.setMatrixAt(k, m4); rm.setMatrixAt(k, m4); });
      pm.castShadow = this.quality.shadows; pm.receiveShadow = true;
      pm.computeBoundingSphere(); rm.computeBoundingSphere();
      group.add(pm, rm);
    }
    return group;
  }

  // ---------------- streaming ----------------
  update(carX, carZ, carIdx, budgetMs, viewChunks) {
    this.ensureRoad(carZ + viewChunks * CHUNK + 300);

    // road blocks
    const bNow = Math.floor(carIdx / BLOCK);
    const bMax = Math.floor((this.rh.length - 3) / BLOCK) - 1;
    const want = new Set();
    for (let b = Math.max(0, bNow - 6); b <= bMax; b++) {
      const i = b * BLOCK;
      const dz = this.rz[i] - carZ, dx = this.rx[i] - carX;
      if (Math.hypot(dx, dz) > viewChunks * CHUNK + 150 && b > bNow) break;
      want.add(b);
      if (!this.roadBlocks.has(b)) {
        const g = this._buildRoadBlock(b); this.scene.add(g); this.roadBlocks.set(b, g);
      }
    }
    for (const [b, g] of this.roadBlocks) if (!want.has(b)) { this._dispose(g); this.roadBlocks.delete(b); }

    // terrain chunks
    const ccx = Math.floor(carX / CHUNK), ccz = Math.floor(carZ / CHUNK);
    const R = viewChunks;
    const needed = new Map();
    const fz = this.finalZ - 80;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz > (R + 0.5) * (R + 0.5)) continue;
      const cx = ccx + dx, cz = ccz + dz;
      if ((cz + 1) * CHUNK > fz) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dz));
      const lod = d <= 1 ? 2 : d <= 3 ? 1 : 0;
      needed.set(cx + ',' + cz, { cx, cz, lod, dist: dx * dx + dz * dz });
    }
    for (const [k, ch] of this.chunks) {
      const nd = needed.get(k);
      if (!nd) { this._dispose(ch.group); this.chunks.delete(k); }
    }
    const todo = [];
    for (const [k, nd] of needed) {
      const ch = this.chunks.get(k);
      if (!ch || ch.lod !== nd.lod) todo.push([k, nd]);
    }
    todo.sort((a, b) => a[1].dist - b[1].dist);
    const t0 = performance.now();
    let built = 0;
    for (const [k, nd] of todo) {
      if (built > 0 && performance.now() - t0 > budgetMs) break;
      const segs = [this.quality.farSegs, 32, 64][nd.lod];
      const g = this._buildChunk(nd.cx, nd.cz, segs, nd.lod);
      const old = this.chunks.get(k);
      if (old) this._dispose(old.group);
      this.scene.add(g);
      this.chunks.set(k, { group: g, lod: nd.lod });
      built++;
    }
    return todo.length - built;
  }

  _dispose(g) {
    this.scene.remove(g);
    g.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      else if (o.isMesh && o.geometry) o.geometry.dispose();
    });
  }

  rebuildAll() {
    for (const [, ch] of this.chunks) this._dispose(ch.group);
    this.chunks.clear();
    for (const [, g] of this.roadBlocks) this._dispose(g);
    this.roadBlocks.clear();
  }
}
