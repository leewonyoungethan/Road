import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, clamp, lerp } from './noise.js';
import { TerrainCore, ROAD_HALF, SHOULDER, EDGE, ROAD_W, LANE, STEP, CHUNK, BLOCK, lin } from './terrain-core.js';
export { ROAD_HALF, SHOULDER, EDGE, ROAD_W, LANE, STEP, CHUNK, WATER_LEVEL } from './terrain-core.js';

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

export class World extends TerrainCore {
  constructor(seed, scene, quality, worldType) {
    super(seed, worldType);
    this.scene = scene;
    this.quality = quality;
    this.chunks = new Map();
    this.roadBlocks = new Map();
    this.pending = new Map();   // key -> { lod, job }
    this.jobId = 0;
    this._makeMaterials();
    this._makeTreeGeometries();
    this._startWorkers();
  }

  _startWorkers() {
    this.workers = [];
    this.syncMode = false;
    const n = clamp((navigator.hardwareConcurrency || 4) - 2, 1, 4);
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./chunk-worker.js', import.meta.url), { type: 'module' });
        w.busy = 0;
        w.onmessage = (e) => { w.busy--; this._onChunk(e.data); };
        w.onerror = (e) => { console.warn('chunk worker failed, using main thread', e.message); this._fallback(); };
        w.postMessage({ type: 'init', seed: this.seed, worldType: this.type });
        this.workers.push(w);
      }
    } catch (err) {
      console.warn('workers unavailable', err);
      this._fallback();
    }
  }

  _fallback() {
    if (this.syncMode) return;
    this.syncMode = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.pending.clear();
  }

  _onChunk(d) {
    const want = this.pending.get(d.key);
    if (!want || want.job !== d.job) return; // stale result
    this.pending.delete(d.key);
    if (!this.needed || !this.needed.has(d.key)) return;
    const g = this._meshFromData(d);
    const old = this.chunks.get(d.key);
    if (old) this._dispose(old.group);
    this.scene.add(g);
    this.chunks.set(d.key, { group: g, lod: d.lod });
  }

  _meshFromData(d) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(d.nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(d.col, 3));
    geo.setIndex(new THREE.BufferAttribute(d.idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(d.cx * CHUNK, 0, d.cz * CHUNK);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    const group = new THREE.Group();
    group.add(mesh);
    const shadows = this.quality.shadows;
    const add = (data, geom, mat, cast) => {
      if (!data || !data.count) return;
      const im = new THREE.InstancedMesh(geom, mat, data.count);
      im.instanceMatrix = new THREE.InstancedBufferAttribute(data.m, 16);
      im.instanceColor = new THREE.InstancedBufferAttribute(data.c, 3);
      im.castShadow = cast; im.receiveShadow = true;
      im.computeBoundingSphere();
      group.add(im);
    };
    add(d.inst.pine, this.pineGeo, this.treeMat, shadows);
    add(d.inst.leaf, this.leafGeo, this.treeMat, shadows);
    add(d.inst.birch, this.birchGeo, this.treeMat, shadows);
    add(d.inst.rock, this.rockGeo, this.rockMat, shadows);
    add(d.inst.grass, this.grassGeo, this.grassMat, false);
    return group;
  }

  // ---------------- materials ----------------
  _makeMaterials() {
    const uniforms = this.sharedUniforms = { uTime: { value: 0 }, uSnow: { value: 0 } };

    const tm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
    tm.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <project_vertex>', 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>');
      sh.uniforms.uSnow = uniforms.uSnow;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnow;\n' + GLSL_NOISE)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec2 wp = mod(vWPos.xz, 1000.0);
          float n1 = pnoise(wp * 0.4, 400.0);
          float n2 = pnoise(wp * 2.3, 2300.0);
          float n3 = pnoise(wp * 0.05, 50.0);
          float n4 = pnoise(wp * 9.0, 9000.0);
          diffuseColor.rgb *= 0.8 + 0.22 * n1 + 0.12 * n2 + 0.22 * (n3 - 0.5) + 0.08 * n4;
          vec3 wn = normalize(inverseTransformDirection(vNormal, viewMatrix));
          float sn = uSnow * smoothstep(0.55, 0.85, wn.y + (n1 - 0.5) * 0.3 + (n2 - 0.5) * 0.15);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.85, 0.9) * (0.92 + 0.08 * n2), sn);`);
    };
    tm.customProgramCacheKey = () => 'terrain';
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
    this.roadMat.onBeforeCompile = (sh) => {
      sh.uniforms.uSnow = uniforms.uSnow;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uSnow;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float edge = smoothstep(0.26, 0.44, abs(vMapUv.x - 0.5));
          float tyre = 1.0 - smoothstep(0.03, 0.08, abs(abs(vMapUv.x - 0.5) - 0.15));
          float sn = uSnow * clamp(0.35 + 0.65 * edge - 0.3 * tyre, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.8, 0.82, 0.86), sn);`);
    };
    this.roadMat.customProgramCacheKey = () => 'road';

    // trees / grass with wind
    const windify = (mat, amp, base, key, snowAmt = 1) => {
      mat.customProgramCacheKey = () => key;
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = uniforms.uTime;
        sh.uniforms.uSnow = uniforms.uSnow;
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uSnow; varying float vUpN;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            float sn = uSnow * ${snowAmt.toFixed(2)} * smoothstep(0.2, 0.75, vUpN);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.93), sn);`);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime; varying float vUpN;')
          .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvUpN = objectNormal.y;')
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
    windify(this.treeMat, 0.018, 1.5, 'tree', 0.9);
    this.grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
    windify(this.grassMat, 0.22, 0.0, 'grass', 0.8);
    this.rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
    windify(this.rockMat, 0.0, 99.0, 'rock', 1.0);
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
  // focusX/Z: point the world is centred on (pushed ahead of the car at speed). fast: 1 = no grass, 2 = coarse only
  update(focusX, focusZ, carIdx, budgetMs, viewChunks, fast = 0) {
    this.ensureRoad(focusZ + viewChunks * CHUNK + 300);

    // road blocks (cheap, main thread)
    const bNow = Math.floor(carIdx / BLOCK);
    const bMax = Math.floor((this.rh.length - 3) / BLOCK) - 1;
    const want = new Set();
    let builtBlocks = 0;
    for (let b = Math.max(0, bNow - 4); b <= bMax; b++) {
      const i = b * BLOCK;
      if (Math.hypot(this.rx[i] - focusX, this.rz[i] - focusZ) > viewChunks * CHUNK + 150 && b > bNow) break;
      want.add(b);
      if (!this.roadBlocks.has(b) && builtBlocks < 4) {
        const g = this._buildRoadBlock(b); this.scene.add(g); this.roadBlocks.set(b, g); builtBlocks++;
      }
    }
    for (const [b, g] of this.roadBlocks) if (!want.has(b)) { this._dispose(g); this.roadBlocks.delete(b); }

    // terrain chunks
    const ccx = Math.floor(focusX / CHUNK), ccz = Math.floor(focusZ / CHUNK);
    const R = viewChunks;
    const needed = new Map();
    const fz = this.finalZ - 80;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz > (R + 0.5) * (R + 0.5)) continue;
      const cx = ccx + dx, cz = ccz + dz;
      if ((cz + 1) * CHUNK > fz) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dz));
      let lod = d <= 1 ? 2 : d <= 3 ? 1 : 0;
      if (fast >= 2) lod = 0; else if (fast >= 1) lod = Math.min(lod, 1);
      needed.set(cx + ',' + cz, { cx, cz, lod, dist: dx * dx + dz * dz });
    }
    this.needed = needed;
    for (const [k, ch] of this.chunks) if (!needed.has(k)) { this._dispose(ch.group); this.chunks.delete(k); }
    for (const k of [...this.pending.keys()]) if (!needed.has(k)) this.pending.delete(k);

    const todo = [];
    for (const [k, nd] of needed) {
      const ch = this.chunks.get(k);
      const p = this.pending.get(k);
      if ((!ch || ch.lod !== nd.lod) && (!p || p.lod !== nd.lod)) todo.push([k, nd]);
    }
    // missing chunks first, then nearest
    todo.sort((a, b) => (this.chunks.has(a[0]) - this.chunks.has(b[0])) || a[1].dist - b[1].dist);
    const opts = { grass: this.quality.grass, grassCount: this.quality.grassCount };
    const segsFor = (lod) => [this.quality.farSegs, 32, 64][lod];

    if (this.syncMode) {
      const t0 = performance.now();
      let built = 0;
      for (const [k, nd] of todo) {
        if (built > 0 && performance.now() - t0 > budgetMs) break;
        const job = ++this.jobId;
        this.pending.set(k, { lod: nd.lod, job });
        const d = this.buildChunkData(nd.cx, nd.cz, segsFor(nd.lod), nd.lod, opts);
        d.key = k; d.lod = nd.lod; d.job = job;
        this._onChunk(d);
        built++;
      }
    } else {
      for (const [k, nd] of todo) {
        let w = null;
        for (const ww of this.workers) if (ww.busy < 3 && (!w || ww.busy < w.busy)) w = ww;
        if (!w) break;
        const job = ++this.jobId;
        this.pending.set(k, { lod: nd.lod, job });
        w.busy++;
        w.postMessage({ type: 'build', key: k, cx: nd.cx, cz: nd.cz, segs: segsFor(nd.lod), lod: nd.lod, detail: nd.lod, job, opts });
      }
    }
    let missing = 0;
    for (const k of needed.keys()) if (!this.chunks.has(k)) missing++;
    return missing;
  }

  _dispose(g) {
    this.scene.remove(g);
    g.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      else if (o.isMesh && o.geometry) o.geometry.dispose();
    });
  }

  // wet surfaces when raining
  setWetness(w) {
    this.roadMat.roughness = lerp(0.82, 0.18, w);
    this.roadMat.color.setScalar(lerp(1, 0.6, w));
    this.terrainMat.roughness = lerp(0.93, 0.62, w);
    this.rockMat.roughness = lerp(0.95, 0.45, w);
  }
}
