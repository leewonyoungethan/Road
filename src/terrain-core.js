// Pure terrain / road maths (no three.js) — shared by the main thread and the chunk worker
import { makeNoise2D, mulberry32, clamp, lerp, smoothstep } from './noise.js';


// ---- Road / world constants ----
export const ROAD_HALF = 3.7;            // asphalt half width (2 lanes)
export const SHOULDER = 1.4;             // paved shoulder
export const EDGE = 0.9;                 // gravel edge
export const ROAD_W = ROAD_HALF + SHOULDER + EDGE;
export const LANE = 1.85;                // lane centre offset
export const STEP = 4;                   // road sample spacing (m)
export const WATER_LEVEL = 0;
export const CELL = 52;
export const CHUNK = 160;
export const BLOCK = 48;                        // road points per mesh block
export const SMOOTH_W = 30;

export const lin = (c) => Math.pow(c, 2.2);

export class TerrainCore {
  constructor(seed) {
    this.seed = seed;
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

  // ---------------- chunk data (runs in the worker) ----------------
  // Returns plain typed arrays so the result can be transferred between threads.
  buildChunkData(cx, cz, segs, detail, opts) {
    const n = segs + 1, step = CHUNK / segs, N = n + 2;
    const ox = cx * CHUNK, oz = cz * CHUNK;
    this.ensureRoad((cz + 2) * CHUNK);
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
    const edges = [];
    for (let i = 0; i < n; i++) edges.push(i);
    for (let i = 0; i < n; i++) edges.push((n - 1) * n + i);
    for (let j = 0; j < n; j++) edges.push(j * n);
    for (let j = 0; j < n; j++) edges.push(j * n + n - 1);
    const drop = Math.max(3, step * 1.5);
    for (let k = 0; k < edges.length; k++) {
      const s = edges[k], v = n * n + k;
      pos[v * 3] = pos[s * 3]; pos[v * 3 + 1] = pos[s * 3 + 1] - drop; pos[v * 3 + 2] = pos[s * 3 + 2];
      for (let c = 0; c < 3; c++) { nor[v * 3 + c] = nor[s * 3 + c]; col[v * 3 + c] = col[s * 3 + c]; }
    }
    const triCount = (n - 1) * (n - 1) * 2 + 4 * (n - 1) * 4;
    const idx = vc > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
    let w = 0;
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[w++] = a; idx[w++] = c; idx[w++] = b; idx[w++] = b; idx[w++] = c; idx[w++] = d;
    }
    for (let e = 0; e < 4; e++) for (let k = 0; k < n - 1; k++) {
      const a = edges[e * n + k], b = edges[e * n + k + 1];
      const sa = n * n + e * n + k, sb = sa + 1;
      idx[w++] = a; idx[w++] = sa; idx[w++] = b; idx[w++] = b; idx[w++] = sa; idx[w++] = sb;
      idx[w++] = a; idx[w++] = b; idx[w++] = sa; idx[w++] = b; idx[w++] = sb; idx[w++] = sa;
    }
    const out = { cx, cz, segs, detail, pos, nor, col, idx, inst: {} };
    if (detail >= 1) this._scatterData(out, cx, cz, n, step, pos, grassy, NY, col, D, N, detail, opts);
    return out;
  }

  _scatterData(out, cx, cz, n, step, pos, grassy, NY, col, D, N, detail, opts) {
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const r = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ this.seed);
    const sampleIdx = (lx, lz) => clamp(Math.round(lz / step), 0, n - 1) * n + clamp(Math.round(lx / step), 0, n - 1);
    const hAt = (lx, lz) => {
      const fx = clamp(lx / step, 0, n - 1.001), fz = clamp(lz / step, 0, n - 1.001);
      const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
      const a = pos[(j * n + i) * 3 + 1], b = pos[(j * n + i + 1) * 3 + 1];
      const c = pos[((j + 1) * n + i) * 3 + 1], d = pos[((j + 1) * n + i + 1) * 3 + 1];
      return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
    };
    const roadD = (lx, lz) => D[(clamp(Math.round(lz / step), 0, n - 1) + 1) * N + clamp(Math.round(lx / step), 0, n - 1) + 1];

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
    const pack = (arr, sMin, sMax, tint) => {
      const m = new Float32Array(arr.length * 16), c = new Float32Array(arr.length * 3);
      for (let k = 0; k < arr.length; k++) {
        const [lx, h, lz, rr] = arr[k];
        const s = lerp(sMin, sMax, rr);
        compose(m, k * 16, ox + lx, h - 0.15, oz + lz, rr * 40, (rr - 0.5) * 0.08, ((rr * 7) % 1 - 0.5) * 0.08, s, s * lerp(0.85, 1.2, (rr * 13) % 1), s);
        const t = tint((rr * 31) % 1);
        c[k * 3] = t[0]; c[k * 3 + 1] = t[1]; c[k * 3 + 2] = t[2];
      }
      return { m, c, count: arr.length };
    };
    out.inst.pine = pack(lists.pine, 0.8, 1.6, (t) => [lerp(0.8, 1.2, t), lerp(0.85, 1.15, t), 0.9]);
    out.inst.leaf = pack(lists.leaf, 0.75, 1.4, (t) => [lerp(0.8, 1.5, t), lerp(0.9, 1.25, t), lerp(0.7, 1.0, t)]);
    out.inst.birch = pack(lists.birch, 0.8, 1.3, (t) => [lerp(0.9, 1.4, t), lerp(0.9, 1.15, t), 0.9]);
    out.inst.rock = pack(lists.rock, 0.3, 1.5, (t) => [lerp(0.8, 1.15, t), lerp(0.8, 1.1, t), lerp(0.8, 1.05, t)]);

    if (detail >= 2 && opts.grass) {
      const G = [];
      for (let k = 0; k < opts.grassCount; k++) {
        const lx = r() * CHUNK, lz = r() * CHUNK;
        const vi = sampleIdx(lx, lz);
        const gs = grassy[vi];
        if (gs < 0.4 || r() > gs) continue;
        if (roadD(lx, lz) < ROAD_W + 0.6) continue;
        const h = hAt(lx, lz);
        if (h < 1.5) continue;
        G.push([lx, h, lz, r(), vi]);
      }
      const m = new Float32Array(G.length * 16), c = new Float32Array(G.length * 3);
      for (let k = 0; k < G.length; k++) {
        const [lx, h, lz, rr, vi] = G[k];
        const s = lerp(0.7, 1.6, rr);
        compose(m, k * 16, ox + lx, h - 0.05, oz + lz, rr * 50, 0, 0, s, s * lerp(0.7, 1.4, (rr * 17) % 1), s);
        const b = 1.25 + ((rr * 7) % 1) * 0.35;
        c[k * 3] = col[vi * 3] * b; c[k * 3 + 1] = col[vi * 3 + 1] * b; c[k * 3 + 2] = col[vi * 3 + 2] * b;
      }
      out.inst.grass = { m, c, count: G.length };
    }
  }
}

// column-major TRS matrix, rotation = Ry(yaw) * Rx(ax) * Rz(az)
function compose(o, k, x, y, z, yaw, ax, az, sx, sy, sz) {
  const cy = Math.cos(yaw), syw = Math.sin(yaw), cx = Math.cos(ax), sxa = Math.sin(ax), cz = Math.cos(az), sza = Math.sin(az);
  const m00 = cy * cz + syw * sxa * sza, m01 = -cy * sza + syw * sxa * cz, m02 = syw * cx;
  const m10 = cx * sza, m11 = cx * cz, m12 = -sxa;
  const m20 = -syw * cz + cy * sxa * sza, m21 = syw * sza + cy * sxa * cz, m22 = cy * cx;
  o[k] = m00 * sx; o[k + 1] = m10 * sx; o[k + 2] = m20 * sx; o[k + 3] = 0;
  o[k + 4] = m01 * sy; o[k + 5] = m11 * sy; o[k + 6] = m21 * sy; o[k + 7] = 0;
  o[k + 8] = m02 * sz; o[k + 9] = m12 * sz; o[k + 10] = m22 * sz; o[k + 11] = 0;
  o[k + 12] = x; o[k + 13] = y; o[k + 14] = z; o[k + 15] = 1;
}
