import * as THREE from 'three';
import { clamp, lerp } from './noise.js';
import { ROAD_HALF, SHOULDER, LANE, STEP } from './world.js';

// per-model dimensions (set by setModel; used by the physics below)
let WB = 2.62;        // wheelbase
let TRACK = 1.62;
let WR = 0.35;        // wheel radius
const RAIL = 55;      // m/s (~200 km/h): above this the car locks to the road

export const CAR_COLORS = [0xc4121e, 0x1a5fd0, 0xeceae4, 0x1a1b1e, 0x1f7a52, 0xf2a81a, 0x8a8f96, 0x6a2bd1];
export const CAR_MODELS = ['sports', 'suv', 'truck', 'bike', 'plane'];
export const CAR_MODEL_NAMES = { sports: '스포츠카', suv: 'SUV', truck: '트럭', bike: '오토바이', plane: '비행기' };

const MODEL_DIMS = {
  sports: { wb: 2.62, track: 1.62, wr: 0.35, tyreW: 0.27, camDist: 7.4, camH: 2.3, hood: [0, 1.12, 0.15] },
  suv: { wb: 2.86, track: 1.72, wr: 0.41, tyreW: 0.3, camDist: 8.4, camH: 2.8, hood: [0, 1.6, 0.4] },
  truck: { wb: 3.4, track: 1.78, wr: 0.45, tyreW: 0.34, camDist: 9.6, camH: 3.1, hood: [0, 1.85, 0.9] },
  plane: { wb: 1.9, track: 2.2, wr: 0.26, tyreW: 0.14, camDist: 17, camH: 4.5, hood: [0, 2.12, 0.15] },
  bike: { wb: 1.45, track: 0.2, wr: 0.31, tyreW: 0.16, camDist: 5.4, camH: 1.8, hood: [0, 1.42, -0.05] },
};

// Lofted body: superellipse cross-sections along z; archFn raises the floor line to cut wheel arches
function loft(keys, z0, z1, step, n, archFn) {
  const lerpKey = (z, k) => {
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i], b = keys[i + 1];
      if (z <= b[0]) { const t = (z - a[0]) / (b[0] - a[0]); const s = t * t * (3 - 2 * t); return a[k] + (b[k] - a[k]) * s; }
    }
    return keys[keys.length - 1][k];
  };
  const R = 28, pos = [], idx = [], zs = [];
  for (let z = z0; z < z1; z += step) zs.push(z);
  zs.push(z1);
  zs.forEach((z) => {
    const w = lerpKey(z, 1), top = lerpKey(z, 2);
    let bot = lerpKey(z, 3);
    if (archFn) bot = Math.max(bot, archFn(z));
    const cy = (top + bot) / 2, hh = Math.max((top - bot) / 2, 0.01);
    for (let k = 0; k < R; k++) {
      const th = (k / R) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
      const x = w * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      let y = cy + hh * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
      if (sn < 0) y = Math.max(y, bot);
      pos.push(x, y, z);
    }
  });
  for (let si = 0; si < zs.length - 1; si++) for (let k = 0; k < R; k++) {
    const a = si * R + k, b = si * R + (k + 1) % R, c = a + R, d = b + R;
    idx.push(a, b, c, b, d, c);
  }
  const cap = (si, flip) => {
    const base = pos.length / 3; let cx = 0, cy = 0;
    for (let k = 0; k < R; k++) { cx += pos[(si * R + k) * 3]; cy += pos[(si * R + k) * 3 + 1]; }
    pos.push(cx / R, cy / R, zs[si]);
    for (let k = 0; k < R; k++) { const a = si * R + k, b = si * R + (k + 1) % R; flip ? idx.push(base, a, b) : idx.push(base, b, a); }
  };
  cap(0, false); cap(zs.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export class Car {
  constructor(scene, world) {
    this.world = world;
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    scene.add(this.group);
    this._materials();
    this.wheels = []; this.beams = [];
    let m = null; try { m = localStorage.getItem('wr-car'); } catch {}
    this.setModel(CAR_MODELS.includes(m) ? m : 'sports');

    this.pos = new THREE.Vector3();
    this.yaw = 0; this.speed = 0; this.steer = 0;
    this.pitch = 0; this.roll = 0; this.y = 0; this.vy = 0;
    this.idx = 0; this.lat = 0; this.dist = 0;
    this.wheelRot = 0;
    this.braking = false;
    this.onRoad = true;
    this.autoSpeed = 22;
    this.rpm = 900; this.gear = 1;
    this.tmp = { x: 0, y: 0, z: 0, fx: 0, fz: 1, heading: 0 };
  }

  _materials() {
    const M = this.mats = {};
    this.paint = new THREE.MeshPhysicalMaterial({ color: CAR_COLORS[0], metalness: 0.6, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.04 });
    M.glass = new THREE.MeshPhysicalMaterial({ color: 0x06080b, metalness: 0.9, roughness: 0.04, clearcoat: 1 });
    M.black = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.55, metalness: 0.3 });
    M.plastic = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.85, metalness: 0 });
    M.carbon = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.35, metalness: 0.5 });
    M.chrome = new THREE.MeshStandardMaterial({ color: 0xd6d9de, roughness: 0.12, metalness: 1 });
    M.alu = new THREE.MeshStandardMaterial({ color: 0x9a9ea4, roughness: 0.35, metalness: 0.9 });
    M.rim = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.25, metalness: 0.9 });
    M.tire = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.92 });
    M.caliper = new THREE.MeshStandardMaterial({ color: 0xd8261c, roughness: 0.4, metalness: 0.3 });
    M.amber = new THREE.MeshStandardMaterial({ color: 0x553300, emissive: 0xff9a1a, emissiveIntensity: 0.6 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf4ff, emissiveIntensity: 0.6 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x500000, emissive: 0xff1208, emissiveIntensity: 0.8 });
  }

  _add(geo, mat, x = 0, y = 0, z = 0, shadow = true) {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
    m.castShadow = shadow; m.receiveShadow = true; this.body.add(m); return m;
  }
  _box(w, h, d, mat, x, y, z, shadow = true) { return this._add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, shadow); }

  setModel(name) {
    if (!MODEL_DIMS[name]) name = 'sports';
    this.model = name;
    try { localStorage.setItem('wr-car', name); } catch {}
    // clear previous model
    for (const o of [...this.body.children]) { this.body.remove(o); o.traverse((c) => c.geometry && c.geometry.dispose()); }
    for (const w of this.wheels) { w.pivot.parent && w.pivot.parent.remove(w.pivot); w.pivot.traverse((c) => c.geometry && c.geometry.dispose()); }
    this.wheels = []; this.beams = [];
    const D = MODEL_DIMS[name];
    WB = D.wb; TRACK = D.track; WR = D.wr;
    this.camDist = D.camDist; this.camH = D.camH; this.hoodCam = D.hood;
    this.fz = WB / 2 + 0.05; this.rz = -WB / 2 + 0.05;
    if (name === 'sports') this._buildSports();
    else if (name === 'suv') this._buildSUV();
    else if (name === 'truck') this._buildTruck();
    else if (name === 'plane') this._buildPlane();
    else this._buildBike();
    this.flying = false; this.rail = false; this.flightPitch = 0; this.altitude = 0;
    this.lean = 0;
  }

  _arch(radius) {
    const fz = this.fz, rz = this.rz;
    return (z) => {
      let h = 0;
      for (const c of [fz, rz]) { const d = Math.abs(z - c); if (d < radius) h = Math.max(h, WR + Math.sqrt(radius * radius - d * d) * 0.95); }
      return h;
    };
  }

  // wheels: style 'sport' (10 thin spokes + callipers), 'suv' (6 spokes), 'offroad' (steel, chunky tyre)
  _wheels(style, tyreW) {
    const M = this.mats;
    const tg = new THREE.CylinderGeometry(WR, WR, tyreW, 32, 1, true); tg.rotateZ(Math.PI / 2);
    const rimR = style === 'offroad' ? 0.6 : style === 'suv' ? 0.7 : 0.74;
    const wall = new THREE.RingGeometry(WR * rimR, WR, 32); wall.rotateY(Math.PI / 2);
    const lip = new THREE.TorusGeometry(WR * rimR, 0.018, 8, 32); lip.rotateY(Math.PI / 2);
    const disc = new THREE.CylinderGeometry(WR * rimR, WR * rimR, tyreW - 0.05, 24); disc.rotateZ(Math.PI / 2);
    const nSp = style === 'sport' ? 10 : style === 'suv' ? 6 : 8;
    const spW = style === 'sport' ? 0.035 : style === 'suv' ? 0.07 : 0.05;
    const spokeG = new THREE.BoxGeometry(0.035, WR * rimR * 0.9, spW); spokeG.translate(0, WR * rimR * 0.48, 0);
    const hub = new THREE.CylinderGeometry(0.07, 0.07, 0.05, 12); hub.rotateZ(Math.PI / 2);
    const cal = new THREE.BoxGeometry(0.06, 0.14, 0.22);
    // tread blocks for the off-road tyre
    const lug = style === 'offroad' ? new THREE.BoxGeometry(tyreW * 0.95, 0.05, 0.1) : null;
    const rimMat = style === 'offroad' ? M.black : style === 'suv' ? M.alu : M.rim;
    for (const [x, z, front] of [[TRACK / 2, this.fz, true], [-TRACK / 2, this.fz, true], [TRACK / 2, this.rz, false], [-TRACK / 2, this.rz, false]]) {
      const side = Math.sign(x);
      const pivot = new THREE.Group(); pivot.position.set(x, WR, z);
      if (style === 'sport') { const c = new THREE.Mesh(cal, M.caliper); c.position.set(side * 0.06, 0.12, -0.08); pivot.add(c); }
      const spin = new THREE.Group(); pivot.add(spin);
      const t = new THREE.Mesh(tg, M.tire); t.castShadow = true; spin.add(t);
      for (const sx of [-1, 1]) { const wm = new THREE.Mesh(wall, M.tire); wm.position.x = sx * tyreW / 2; if (sx < 0) wm.rotation.y = Math.PI; spin.add(wm); }
      if (lug) for (let k = 0; k < 20; k++) {
        const l = new THREE.Mesh(lug, M.tire); const a = (k / 20) * Math.PI * 2;
        l.position.set(0, Math.cos(a) * WR, Math.sin(a) * WR); l.rotation.x = a; spin.add(l);
      }
      spin.add(new THREE.Mesh(disc, M.black));
      const face = new THREE.Group(); face.position.x = side * (tyreW / 2 - 0.01); spin.add(face);
      face.add(new THREE.Mesh(lip, M.chrome));
      for (let k = 0; k < nSp; k++) { const sp = new THREE.Mesh(spokeG, rimMat); sp.rotation.x = (k / nSp) * Math.PI * 2; face.add(sp); }
      face.add(new THREE.Mesh(hub, M.chrome));
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, front });
    }
  }

  _lights(fx, fy, fz, rz, ry) {
    for (const s of [-1, 1]) {
      const sp = new THREE.SpotLight(0xf2f6ff, 0, 100, 0.45, 0.55, 1.3);
      sp.position.set(s * fx, fy, fz);
      sp.target.position.set(s * 0.9, 0, 24);
      this.body.add(sp, sp.target);
      this.beams.push(sp);
    }
    this.tailLight = new THREE.PointLight(0xff2010, 0, 8, 2);
    this.tailLight.position.set(0, ry, rz - 0.3);
    this.body.add(this.tailLight);
  }

  // ---------------- sports coupe ----------------
  _buildSports() {
    const M = this.mats, P = this.paint, add = this._add.bind(this);
    const bodyKeys = [
      [-2.3, 0.78, 0.74, 0.36], [-2.18, 0.9, 0.86, 0.3], [-1.85, 0.97, 0.92, 0.28], [-1.3, 0.98, 0.9, 0.28],
      [-0.7, 0.93, 0.87, 0.28], [0.1, 0.93, 0.85, 0.28], [0.8, 0.97, 0.82, 0.28], [1.5, 0.96, 0.74, 0.28],
      [2.0, 0.9, 0.64, 0.29], [2.3, 0.76, 0.52, 0.31], [2.38, 0.6, 0.44, 0.33],
    ];
    add(loft(bodyKeys, -2.3, 2.38, 0.05, 3.4, this._arch(0.46)), P);
    const cabKeys = [[-1.75, 0.62, 0.92, 0.8], [-1.25, 0.7, 1.19, 0.8], [-0.6, 0.73, 1.3, 0.8], [0.0, 0.73, 1.31, 0.8], [0.45, 0.71, 1.21, 0.8], [1.02, 0.66, 0.9, 0.8]];
    add(loft(cabKeys, -1.75, 1.02, 0.06, 2.6), M.glass);
    const roofKeys = [[-0.9, 0.5, 1.272, 1.18], [-0.55, 0.58, 1.316, 1.2], [0.0, 0.58, 1.322, 1.2], [0.3, 0.52, 1.27, 1.18]];
    add(loft(roofKeys, -0.9, 0.3, 0.05, 2.6), P);
    this._box(1.35, 0.04, 0.22, M.carbon, 0, 0.3, 2.22);
    for (const s of [-1, 1]) this._box(0.08, 0.1, 1.75, M.carbon, s * 0.94, 0.33, 0.0);
    this._box(1.5, 0.16, 0.3, M.carbon, 0, 0.36, -2.18);
    for (let k = -2; k <= 2; k++) this._box(0.02, 0.14, 0.28, M.black, k * 0.25, 0.35, -2.2, false);
    for (const s of [-1, 1]) {
      const ex = new THREE.CylinderGeometry(0.055, 0.055, 0.18, 14); ex.rotateX(Math.PI / 2);
      add(ex, M.chrome, s * 0.52, 0.38, -2.33, false);
      const hl = this._box(0.34, 0.05, 0.08, this.headMat, s * 0.56, 0.6, 2.18, false); hl.rotation.y = s * -0.28;
      const drl = this._box(0.3, 0.016, 0.08, this.headMat, s * 0.58, 0.56, 2.19, false); drl.rotation.y = s * -0.28;
      const mir = this._box(0.2, 0.08, 0.13, P, s * 0.86, 0.98, 0.78); mir.rotation.y = s * 0.15;
      this._box(0.1, 0.04, 0.04, M.black, s * 0.77, 0.95, 0.78, false);
      this._box(0.2, 0.09, 0.06, this.tailMat, s * 0.68, 0.79, -2.25, false);
    }
    this._box(1.5, 0.045, 0.06, this.tailMat, 0, 0.8, -2.27, false);
    this._box(0.95, 0.12, 0.05, M.black, 0, 0.42, 2.34, false);
    const wing = new THREE.BoxGeometry(1.74, 0.03, 0.3); wing.rotateX(-0.08);
    add(wing, M.carbon, 0, 1.04, -2.0);
    for (const s of [-1, 1]) {
      this._box(0.04, 0.22, 0.16, M.carbon, s * 0.55, 0.93, -1.98);
      this._box(0.02, 0.12, 0.34, M.carbon, s * 0.87, 1.06, -2.0);
    }
    this._wheels('sport', MODEL_DIMS.sports.tyreW);
    this._lights(0.58, 0.62, 2.25, -2.3, 0.8);
  }

  // ---------------- SUV ----------------
  _buildSUV() {
    const M = this.mats, P = this.paint, add = this._add.bind(this);
    //            z      halfW  top   bottom
    const bodyKeys = [
      [-2.42, 0.86, 1.12, 0.5], [-2.32, 0.95, 1.16, 0.45], [-1.6, 0.98, 1.16, 0.45], [-0.5, 0.97, 1.14, 0.45],
      [0.6, 0.97, 1.12, 0.45], [1.5, 0.97, 1.08, 0.45], [2.05, 0.94, 1.02, 0.47], [2.35, 0.86, 0.92, 0.5], [2.45, 0.74, 0.82, 0.56],
    ];
    add(loft(bodyKeys, -2.42, 2.45, 0.05, 4.6, this._arch(0.55)), P);
    // tall greenhouse
    const cabKeys = [[-2.32, 0.84, 1.66, 1.0], [-1.9, 0.86, 1.78, 1.0], [-0.6, 0.87, 1.8, 1.0], [0.6, 0.86, 1.76, 1.0], [1.15, 0.82, 1.5, 1.0], [1.45, 0.78, 1.14, 1.0]];
    add(loft(cabKeys, -2.32, 1.45, 0.06, 4), M.glass);
    const roofKeys = [[-2.28, 0.8, 1.79, 1.66], [-1.9, 0.83, 1.82, 1.7], [0.5, 0.83, 1.82, 1.7], [0.95, 0.79, 1.74, 1.62]];
    add(loft(roofKeys, -2.28, 0.95, 0.06, 4), P);
    // roof rails
    for (const s of [-1, 1]) {
      this._box(0.05, 0.05, 2.7, M.alu, s * 0.68, 1.86, -0.62);
      for (const z of [-1.85, -0.6, 0.6]) this._box(0.05, 0.06, 0.06, M.black, s * 0.68, 1.82, z, false);
    }
    // black plastic cladding over the arches & lower body
    for (const s of [-1, 1]) {
      this._box(0.06, 0.16, 4.2, M.plastic, s * 0.97, 0.52, 0);
      for (const z of [this.fz, this.rz]) {
        const ring = new THREE.TorusGeometry(WR + 0.12, 0.06, 6, 20, Math.PI); ring.rotateY(Math.PI / 2);
        add(ring, M.plastic, s * 0.95, WR, z);
      }
      const mir = this._box(0.22, 0.13, 0.16, M.black, s * 1.0, 1.22, 1.35); mir.rotation.y = s * 0.12;
      // tall tail lights & slim headlights
      this._box(0.06, 0.24, 0.1, this.tailMat, s * 0.8, 0.98, -2.4, false);
      this._box(0.36, 0.08, 0.06, this.headMat, s * 0.6, 0.94, 2.41, false);
      this._box(0.28, 0.025, 0.06, this.headMat, s * 0.6, 0.86, 2.43, false);
      this._box(0.12, 0.06, 0.05, M.amber, s * 0.82, 0.72, 2.4, false);
    }
    // big grille + silver skid plates
    this._box(1.0, 0.3, 0.06, M.black, 0, 0.78, 2.45, false);
    for (let k = 0; k < 4; k++) this._box(0.98, 0.02, 0.07, M.chrome, 0, 0.68 + k * 0.07, 2.46, false);
    this._box(1.2, 0.12, 0.3, M.alu, 0, 0.52, 2.36);
    this._box(1.3, 0.14, 0.3, M.plastic, 0, 0.55, -2.38);
    this._box(1.0, 0.08, 0.2, M.alu, 0, 0.5, -2.45);
    this._box(1.45, 0.05, 0.06, this.tailMat, 0, 1.36, -2.33, false);
    // spoiler lip over the tailgate
    this._box(1.4, 0.05, 0.2, P, 0, 1.8, -2.2);
    this._wheels('suv', MODEL_DIMS.suv.tyreW);
    this._lights(0.6, 0.94, 2.45, -2.4, 1.15);
  }

  // ---------------- pickup truck ----------------
  _buildTruck() {
    const M = this.mats, P = this.paint, add = this._add.bind(this);
    const arch = this._arch(0.6);
    // cab + hood
    const front = [
      [-0.55, 0.96, 1.25, 0.58], [-0.4, 1.0, 1.25, 0.58], [0.8, 1.0, 1.24, 0.58], [1.8, 0.99, 1.24, 0.58],
      [2.4, 0.97, 1.2, 0.6], [2.75, 0.9, 1.1, 0.62], [2.85, 0.82, 1.0, 0.7],
    ];
    add(loft(front, -0.55, 2.85, 0.05, 5.5, arch), P);
    const cabKeys = [[-0.52, 0.9, 1.98, 1.2], [-0.35, 0.92, 2.0, 1.2], [0.75, 0.92, 2.0, 1.2], [1.2, 0.88, 1.78, 1.2], [1.6, 0.84, 1.26, 1.2]];
    add(loft(cabKeys, -0.52, 1.6, 0.06, 5), M.glass);
    const roofKeys = [[-0.5, 0.88, 2.02, 1.9], [-0.35, 0.91, 2.04, 1.92], [0.7, 0.91, 2.04, 1.92], [1.05, 0.87, 1.96, 1.84]];
    add(loft(roofKeys, -0.5, 1.05, 0.05, 5), P);
    // bed: floor, sides, tailgate (with wheel arches on the sides)
    const bz0 = -2.75, bz1 = -0.62, bl = bz1 - bz0, bc = (bz0 + bz1) / 2;
    add(loft([[bz0, 1.0, 0.9, 0.58], [bz1, 1.0, 0.9, 0.58]], bz0, bz1, 0.05, 5.5, arch), P);
    this._box(1.86, 0.04, bl, M.plastic, 0, 0.92, bc);
    for (const s of [-1, 1]) {
      this._box(0.08, 0.36, bl, P, s * 0.96, 1.08, bc);
      this._box(0.1, 0.04, bl, M.black, s * 0.96, 1.27, bc, false);
      this._box(0.07, 0.3, 0.12, this.tailMat, s * 0.92, 1.05, bz0 - 0.02, false);
      // fender flares
      for (const z of [this.fz, this.rz]) {
        const ring = new THREE.TorusGeometry(WR + 0.14, 0.08, 6, 20, Math.PI); ring.rotateY(Math.PI / 2);
        add(ring, M.plastic, s * 0.98, WR, z);
      }
      const mir = this._box(0.26, 0.2, 0.08, M.black, s * 1.05, 1.42, 1.45); mir.rotation.y = s * 0.1;
      this._box(0.3, 0.16, 0.06, this.headMat, s * 0.66, 1.0, 2.86, false);
      this._box(0.08, 0.04, 2.2, M.alu, s * 0.98, 0.56, 0.6); // step bar
    }
    this._box(1.92, 0.38, 0.08, P, 0, 1.08, bz0);
    // tall chrome grille
    this._box(1.1, 0.42, 0.06, M.black, 0, 0.98, 2.86, false);
    for (let k = 0; k < 3; k++) this._box(1.12, 0.05, 0.08, M.chrome, 0, 0.84 + k * 0.14, 2.87, false);
    this._box(1.9, 0.2, 0.25, M.chrome, 0, 0.62, 2.88);
    this._box(1.9, 0.18, 0.22, M.chrome, 0, 0.62, -2.82);
    this._box(0.12, 0.12, 0.3, M.black, 0, 0.5, -3.0); // tow hitch
    // roof light bar
    this._box(1.3, 0.1, 0.12, M.black, 0, 2.1, 0.55);
    for (let k = -2; k <= 2; k++) this._box(0.2, 0.06, 0.04, this.headMat, k * 0.25, 2.1, 0.62, false);
    for (const s of [-1, 1]) this._box(0.05, 0.12, 0.05, M.black, s * 0.6, 2.06, 0.55, false);
    // cab-top amber markers
    for (let k = -1; k <= 1; k++) this._box(0.08, 0.03, 0.04, M.amber, k * 0.2, 2.05, 1.08, false);
    this._wheels('offroad', MODEL_DIMS.truck.tyreW);
    this._lights(0.66, 1.0, 2.86, -2.8, 1.05);
  }

  // ---------------- motorbike ----------------
  _buildBike() {
    const M = this.mats, P = this.paint, add = this._add.bind(this);
    const fz = this.fz, rz = this.rz;
    const suit = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.7 });
    const helmet = new THREE.MeshPhysicalMaterial({ color: 0x0d0d0f, roughness: 0.2, clearcoat: 1 });
    // fuel tank, fairing, tail
    add(loft([[-0.12, 0.13, 0.98, 0.72], [0.15, 0.17, 1.06, 0.7], [0.42, 0.15, 1.02, 0.72], [0.55, 0.11, 0.92, 0.76]], -0.12, 0.55, 0.04, 2.6), P);
    add(loft([[0.48, 0.2, 1.08, 0.58], [0.75, 0.22, 1.05, 0.55], [0.98, 0.15, 0.92, 0.6], [1.06, 0.08, 0.8, 0.68]], 0.48, 1.06, 0.04, 2.4), P);
    add(loft([[-0.98, 0.04, 0.98, 0.9], [-0.85, 0.1, 1.0, 0.84], [-0.5, 0.13, 0.96, 0.76], [-0.3, 0.13, 0.92, 0.74]], -0.98, -0.3, 0.04, 2.4), P);
    // windscreen
    const ws = new THREE.BoxGeometry(0.3, 0.26, 0.02); ws.rotateX(-0.75);
    add(ws, M.glass, 0, 1.08, 0.82, false);
    // seat
    add(loft([[-0.62, 0.11, 0.96, 0.86], [-0.4, 0.14, 0.95, 0.85], [-0.12, 0.14, 0.94, 0.84]], -0.62, -0.12, 0.04, 3), M.black);
    // engine block, frame and swingarm
    this._box(0.3, 0.32, 0.46, M.black, 0, 0.5, 0.12);
    this._box(0.32, 0.12, 0.3, M.alu, 0, 0.66, 0.2);
    for (let k = 0; k < 4; k++) this._box(0.34, 0.015, 0.24, M.alu, 0, 0.44 + k * 0.05, 0.12, false);
    for (const s of [-1, 1]) {
      const fr = this._box(0.04, 0.05, 0.9, M.alu, s * 0.12, 0.74, 0.2); fr.rotation.x = 0.25;
      const sw = this._box(0.04, 0.06, 0.62, M.alu, s * 0.1, WR + 0.06, rz + 0.33); sw.rotation.x = -0.1;
    }
    // exhaust
    const ex = new THREE.CylinderGeometry(0.06, 0.05, 0.6, 14); ex.rotateX(Math.PI / 2 - 0.2);
    add(ex, M.chrome, -0.16, 0.55, -0.55);
    const exT = new THREE.CylinderGeometry(0.045, 0.045, 0.02, 12); exT.rotateX(Math.PI / 2 - 0.2);
    add(exT, M.black, -0.16, 0.6, -0.86, false);
    // lights
    this._box(0.16, 0.07, 0.04, this.headMat, 0, 0.9, 1.06, false);
    for (const s of [-1, 1]) this._box(0.05, 0.03, 0.03, this.headMat, s * 0.1, 0.83, 1.03, false);
    this._box(0.16, 0.04, 0.03, this.tailMat, 0, 0.95, -0.99, false);
    this._box(0.12, 0.06, 0.01, new THREE.MeshStandardMaterial({ color: 0xf0f0f0 }), 0, 0.78, -0.98, false);

    // rider
    const torso = new THREE.CapsuleGeometry(0.17, 0.42, 4, 10); torso.rotateX(0.95);
    add(torso, suit, 0, 1.22, -0.18);
    const hb = new THREE.SphereGeometry(0.15, 18, 14);
    add(hb, helmet, 0, 1.52, 0.17);
    const visor = new THREE.SphereGeometry(0.152, 18, 10, -Math.PI * 0.45, Math.PI * 0.9, Math.PI * 0.35, Math.PI * 0.3);
    add(visor, M.glass, 0, 1.52, 0.17, false);
    this._box(0.04, 0.03, 0.24, P, 0, 1.62, 0.12, false); // helmet stripe
    for (const s of [-1, 1]) {
      const arm = new THREE.CapsuleGeometry(0.05, 0.46, 4, 8); arm.rotateX(-0.86);
      add(arm, suit, s * 0.21, 1.2, 0.24);
      const thigh = new THREE.CapsuleGeometry(0.075, 0.36, 4, 8); thigh.rotateX(1.35);
      add(thigh, suit, s * 0.2, 0.98, -0.18);
      const shin = new THREE.CapsuleGeometry(0.06, 0.34, 4, 8); shin.rotateX(-0.5);
      add(shin, suit, s * 0.22, 0.72, -0.02);
      this._box(0.08, 0.06, 0.2, M.black, s * 0.22, 0.52, 0.02); // boots
    }

    // wheels: thin tyres, spoked rims, brake discs; the fork + bars steer with the front wheel
    const tyre = new THREE.TorusGeometry(WR - 0.07, 0.075, 12, 32); tyre.rotateY(Math.PI / 2);
    const rim = new THREE.TorusGeometry(WR - 0.13, 0.018, 6, 28); rim.rotateY(Math.PI / 2);
    const spoke = new THREE.BoxGeometry(0.02, WR - 0.13, 0.025); spoke.translate(0, (WR - 0.13) / 2, 0);
    const disc = new THREE.CylinderGeometry(0.15, 0.15, 0.012, 24); disc.rotateZ(Math.PI / 2);
    for (const [z, front] of [[fz, true], [rz, false]]) {
      const pivot = new THREE.Group(); pivot.position.set(0, WR, z);
      const spin = new THREE.Group(); pivot.add(spin);
      const t = new THREE.Mesh(tyre, M.tire); t.castShadow = true; spin.add(t);
      spin.add(new THREE.Mesh(rim, M.chrome));
      for (let k = 0; k < 6; k++) { const sp = new THREE.Mesh(spoke, M.rim); sp.rotation.x = (k / 6) * Math.PI * 2; spin.add(sp); }
      const d = new THREE.Mesh(disc, M.alu); d.position.x = 0.07; spin.add(d);
      if (front) {
        for (const s of [-1, 1]) {
          const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.72, 8), M.alu);
          fork.position.set(s * 0.1, 0.33, -0.12); fork.rotation.x = -0.4; fork.castShadow = true; pivot.add(fork);
        }
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.62, 8), M.black);
        bar.rotation.z = Math.PI / 2; bar.position.set(0, 0.7, -0.3); pivot.add(bar);
        const fender = new THREE.Mesh(new THREE.TorusGeometry(WR + 0.02, 0.03, 4, 16, Math.PI * 0.6), P);
        fender.rotation.y = Math.PI / 2; fender.rotation.x = Math.PI * 0.2; pivot.add(fender);
      }
      this.body.add(pivot); // inside the body so the wheels lean with it
      this.wheels.push({ pivot, spin, front });
    }
    this._lights(0.03, 0.9, 1.08, -0.98, 0.95);
  }

  // ---------------- aeroplane ----------------
  _buildPlane() {
    const M = this.mats, P = this.paint, add = this._add.bind(this);
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4, metalness: 0.1 });
    // tapered, swept slab (wings, tailplane)
    const slab = (span, thick, chord, taper, dihedral, sweep) => {
      const g = new THREE.BoxGeometry(span, thick, chord, 12, 1, 1);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), a = Math.abs(x) / (span / 2);
        p.setZ(i, p.getZ(i) * (1 - taper * a) - sweep * a);
        p.setY(i, p.getY(i) * (1 - 0.5 * a) + dihedral * a);
      }
      g.computeVertexNormals();
      return g;
    };
    add(loft([[-4.3, 0.06, 1.85, 1.68], [-3.2, 0.26, 1.85, 1.3], [-1.4, 0.52, 2.0, 1.0], [0.2, 0.6, 2.04, 0.92], [1.4, 0.56, 1.9, 0.96], [2.2, 0.44, 1.66, 1.06], [2.62, 0.26, 1.5, 1.16]], -4.3, 2.62, 0.05, 2.4), P);
    add(loft([[-1.0, 0.3, 1.98, 1.72], [-0.3, 0.46, 2.38, 1.72], [0.6, 0.44, 2.3, 1.72], [1.15, 0.3, 1.96, 1.72]], -1.0, 1.15, 0.05, 2.1), M.glass);
    add(slab(9.6, 0.16, 1.6, 0.45, 0.28, 0.25), P, 0, 1.08, 0.1);
    add(slab(3.4, 0.08, 0.85, 0.4, 0, 0.15), P, 0, 1.75, -3.85);
    // vertical fin
    const fin = new THREE.BoxGeometry(0.08, 1.35, 1.1, 1, 6, 1);
    { const p = fin.attributes.position; for (let i = 0; i < p.count; i++) { const t = (p.getY(i) + 0.675) / 1.35; p.setZ(i, p.getZ(i) * (1 - 0.45 * t) - 0.55 * t); } fin.computeVertexNormals(); }
    add(fin, P, 0, 2.45, -3.7);
    // white livery stripes
    for (const sx of [-1, 1]) this._box(0.02, 0.1, 2.6, white, sx * 0.585, 1.5, 0.3, false);
    add(slab(9.62, 0.02, 0.3, 0.45, 0.28, 0.25), white, 0, 1.17, -0.3, false);
    // nose spinner + propeller
    const spin = new THREE.ConeGeometry(0.22, 0.5, 16); spin.rotateX(Math.PI / 2);
    add(spin, M.chrome, 0, 1.36, 2.85);
    this.prop = new THREE.Group(); this.prop.position.set(0, 1.36, 2.82); this.body.add(this.prop);
    for (let k = 0; k < 3; k++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.95, 0.03), M.black);
      b.geometry.translate(0, 0.48, 0); b.rotation.z = (k / 3) * Math.PI * 2; b.rotation.y = 0.25; this.prop.add(b);
    }
    // wingtip navigation lights (red left / green right) + tail strobe
    const red = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2020, emissiveIntensity: 2 });
    const green = new THREE.MeshStandardMaterial({ color: 0x003000, emissive: 0x20ff40, emissiveIntensity: 2 });
    this._box(0.1, 0.08, 0.16, red, 4.8, 1.36, -0.12, false);
    this._box(0.1, 0.08, 0.16, green, -4.8, 1.36, -0.12, false);
    this._box(0.06, 0.06, 0.1, this.tailMat, 0, 3.12, -4.28, false);
    this._box(0.3, 0.08, 0.05, this.headMat, 0, 1.12, 2.5, false);
    // landing gear: fixed struts + wheel fairings
    const gear = [[1.15, 0.1, false], [-1.15, 0.1, false], [0, 2.0, true]];
    const tg = new THREE.CylinderGeometry(WR, WR, 0.14, 20); tg.rotateZ(Math.PI / 2);
    for (const [x, z, front] of gear) {
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.95, 8), M.alu);
      strut.position.set(x * 0.85, 0.75, z); strut.rotation.z = x * 0.2; strut.castShadow = true; this.body.add(strut);
      const pivot = new THREE.Group(); pivot.position.set(x, WR, z);
      const spinG = new THREE.Group(); pivot.add(spinG);
      const t = new THREE.Mesh(tg, M.tire); t.castShadow = true; spinG.add(t);
      const fair = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), P); fair.scale.set(0.45, 0.6, 1.2); fair.position.y = 0.06; pivot.add(fair);
      this.body.add(pivot);
      this.wheels.push({ pivot, spin: spinG, front });
    }
    this._lights(0.15, 1.12, 2.55, -4.3, 3.1);
  }

  // arcade flight model: speed is held at the speed setting (min take-off speed),
  // W/S pitch, A/D bank (banking turns the plane), Space slows down.
  _updatePlane(dt, input, auto, loc) {
    const w = this.world;
    const target = Math.max(this.autoSpeed, 45);
    let pitchIn = 0, rollIn = 0, slow = input.space ? 1 : 0;
    const ground = w.groundAt(this.pos.x, this.pos.z);
    const agl = this.y - ground;
    if (auto) {
      // autopilot: follow the road from the air, staying well above the terrain ahead
      const sp = Math.max(this.speed, 20);
      const tgt = w.sample(loc.i + loc.t + (220 + sp * 2.5) / STEP, this.tmp);
      const want = Math.atan2(tgt.x - this.pos.x, tgt.z - this.pos.z);
      let err = want - this.yaw; err = Math.atan2(Math.sin(err), Math.cos(err));
      rollIn = clamp(-err * 2.2, -1, 1);
      const [fx, fz] = this.dir;
      let hi = ground;
      for (const d of [80, 200, 400, 700]) hi = Math.max(hi, w.groundAt(this.pos.x + fx * d * Math.max(1, sp / 60), this.pos.z + fz * d * Math.max(1, sp / 60)));
      const altT = hi + 90;
      const pT = this.speed < 32 ? 0 : clamp(Math.atan2(altT - this.y, 250), -0.3, 0.4);
      pitchIn = clamp((pT - this.flightPitch) * 3, -1, 1);
    } else {
      pitchIn = (input.throttle ? 1 : 0) - (input.brake && !input.space ? 1 : 0);
      rollIn = input.steer;
    }
    if (this.flightPitch === undefined) this.flightPitch = 0;

    // speed: auto-throttle to the target, Space = air brake
    const boost = Math.max(0, target - 50) * 0.3;
    const err = target * (slow ? 0.35 : 1) - this.speed;
    this.speed += clamp(err, -(14 + boost), 9 + boost) * dt * (err > 0 ? 0.6 : 1);
    this.speed -= Math.sin(this.flightPitch) * 9.81 * 0.3 * dt; // climbing costs a little speed
    this.speed = Math.max(this.speed, 0);
    this.throttleIn = err > 0 ? 1 : 0.2;
    this.braking = slow > 0;

    const lift = clamp((this.speed - 24) / 14, 0, 1);
    const onGround = agl <= 0.05;
    // pitch & bank
    if (onGround && lift < 1) pitchIn = Math.min(pitchIn, 0) + (lift >= 1 ? pitchIn : 0);
    this.flightPitch = clamp(this.flightPitch + pitchIn * 0.9 * dt, -1.2, 1.2);
    if (!pitchIn && !onGround) this.flightPitch *= Math.exp(-0.25 * dt);
    if (onGround && this.flightPitch < 0) this.flightPitch = 0;
    const rollT = onGround ? 0 : rollIn * 0.95;
    this.roll = lerp(this.roll, rollT, 1 - Math.exp(-3 * dt));
    // banked turn (on the ground: nose-wheel steering)
    const yawRate = onGround ? clamp(rollIn * 0.6 * Math.min(1, this.speed / 8), -0.6, 0.6) : -Math.tan(this.roll) * 0.75;
    this.yaw += onGround ? -yawRate * dt : yawRate * dt;

    // move
    const cp = Math.cos(this.flightPitch);
    const [fx, fz] = this.dir;
    this.pos.x += fx * cp * this.speed * dt;
    this.pos.z += fz * cp * this.speed * dt;
    const climb = Math.sin(this.flightPitch) * this.speed * lift - (1 - lift) * (onGround ? 0 : 9);
    this.y += climb * dt;
    this.dist += this.speed * dt;
    const g2 = w.groundAt(this.pos.x, this.pos.z);
    if (this.y <= g2) {
      if (!onGround && climb < -12 && this.onLand) this.onLand(-climb, 1.5);
      this.y = g2;
      if (this.flightPitch < 0) this.flightPitch = 0;
    }
    this.airborne = this.y > g2 + 0.3;
    this.altitude = this.y - g2;
    this.pitch = this.flightPitch;
    this.steer = onGround ? rollIn * 0.4 : 0;
    if (this.prop) this.prop.rotation.z += (20 + this.speed * 0.8) * dt;
    this._finishPose(dt, 0, 0);
  }

  setColor(hex) { this.paint.color.setHex(hex); }

  placeOnRoad(i, lat = LANE) {
    const w = this.world;
    const s = w.sample(i, this.tmp);
    this.pos.set(s.x - s.fz * lat, s.y, s.z + s.fx * lat);
    this.yaw = s.heading;
    this.speed = 0; this.steer = 0; this.idx = Math.floor(i);
    this.y = s.y; this.vy = 0; this.rail = false; this.airborne = false;
  }

  get dir() { return [Math.sin(this.yaw), Math.cos(this.yaw)]; }

  update(dt, input, auto, night) {
    this._night = night;
    const w = this.world;
    const [fx, fz] = this.dir;
    const rxv = -fz, rzv = fx;

    // where are we on the road?
    const loc = w.locate(this.pos.x, this.pos.z, this.idx);
    this.idx = loc.i;
    const s0 = w.sample(loc.i + loc.t, this.tmp);
    const dxp = this.pos.x - s0.x, dzp = this.pos.z - s0.z;
    this.lat = dxp * -s0.fz + dzp * s0.fx;
    this.onRoad = Math.abs(this.lat) < ROAD_HALF + SHOULDER + 0.3;
    if (this.model === 'plane') { this._updatePlane(dt, input, auto, loc); return; }

    let throttle = 0, brake = 0, steerIn = 0;
    if (auto) {
      const look = 7 + Math.abs(this.speed) * 0.85;
      const tgt = w.sample(loc.i + loc.t + look / STEP, this.tmp);
      const tx = tgt.x - tgt.fz * LANE - this.pos.x, tz = tgt.z + tgt.fx * LANE - this.pos.z;
      const rightC = tx * rxv + tz * rzv;
      const ld2 = tx * tx + tz * tz;
      const delta = Math.atan2(2 * WB * rightC, ld2);
      steerIn = clamp(delta / 0.5, -1, 1);
      const k = w.curvatureAhead(loc.i, 60 + Math.abs(this.speed) * 3.2);
      const vmax = this.autoSpeed > RAIL ? this.autoSpeed : Math.min(this.autoSpeed, Math.sqrt(2.6 / Math.max(k, 1e-4)));
      const err = vmax - this.speed;
      const sc = Math.max(1, this.autoSpeed / 30);
      if (err > 0) throttle = clamp(err * 0.35 / sc, 0, 1);
      else brake = clamp(-err * 0.12 / sc, 0, 1);
      if (input.brake) { brake = 1; throttle = 0; }
    } else {
      throttle = input.throttle; brake = input.brake; steerIn = input.steer;
    }

    // steering
    const maxSteer = Math.max(0.55 / (1 + Math.abs(this.speed) * 0.03), 0.015);
    const targetSteer = steerIn * maxSteer;
    const rate = auto ? 4 : (steerIn === 0 ? 5 : 2.5);
    this.steer = lerp(this.steer, targetSteer, 1 - Math.exp(-rate * dt));

    // longitudinal dynamics
    const limit = this.autoSpeed;               // the speed setting (m/s) caps manual driving too
    const maxV = limit; // no off-road penalty: drive anywhere, even up mountains
    const boost = Math.max(0, limit - 50) * 0.32; // so very high limits are reached in a few seconds
    const revMax = Math.max(20, limit * 0.75);  // reverse top speed: 75% of the speed setting (at least 72 km/h)
    let a = 0;
    if (throttle > 0) {
      if (this.speed < -0.5) a += throttle * (14 + boost * 1.2); // stop reversing quickly
      else a += throttle * (7.2 + boost) * clamp(1 - this.speed / maxV, 0, 1) + 0.6 * throttle * (this.speed < maxV ? 1 : 0);
    }
    if (this.speed > maxV + 1) a -= (this.speed - maxV) * 1.5;
    if (brake > 0) {
      if (this.speed > 0.3) a -= brake * (13 + boost * 1.2);
      else if (!auto) a -= brake * (9 + boost * 0.8) * clamp(3 * (1 + this.speed / revMax), 0, 1); // reverse: quick, up to revMax
      else this.speed *= 0.9;
    }
    a -= 0.0011 * this.speed * Math.abs(this.speed) * Math.min(1, (58 / Math.max(limit, 1)) ** 2);
    a -= Math.sign(this.speed) * 0.18;
    if (this.airborne) a *= 0.6;
    const prev = this.speed;
    this.speed += a * dt;
    if (!auto && this.speed < -revMax) this.speed = -revMax;
    if (Math.sign(prev) !== Math.sign(this.speed) && throttle === 0 && brake === 0) this.speed = 0;
    if (Math.abs(this.speed) < 0.05 && throttle === 0 && brake === 0) this.speed = 0;
    this.braking = brake > 0.05 && this.speed > 0.5;
    this.throttleIn = throttle;

    // above RAIL speed the car follows the road like a rail (steering only shifts lanes)
    if (this.rail && !auto) this.rail = false;
    if (!this.rail && auto && this.speed > RAIL && this.onRoad && !this.airborne) {
      this.rail = true; this.railS = loc.i + loc.t; this.railLat = clamp(this.lat, -ROAD_HALF + 0.9, ROAD_HALF - 0.9);
    } else if (this.rail && this.speed < RAIL - 6) this.rail = false;

    if (this.rail) {
      if (auto) this.railLat = lerp(this.railLat, LANE, 1 - Math.exp(-2 * dt));
      else this.railLat = clamp(this.railLat + steerIn * dt * 5, -ROAD_HALF + 0.9, ROAD_HALF - 0.9);
      this.railS += (this.speed * dt) / STEP;
      const sN = w.sample(this.railS, this.tmp);
      const sx = sN.x, sz = sN.z, sy = sN.y, sfx = sN.fx, sfz = sN.fz, sh = sN.heading;
      const ahead = w.sample(this.railS + 1, this.tmp);
      this.pos.x = sx - sfz * this.railLat; this.pos.z = sz + sfx * this.railLat;
      let dyaw = sh - this.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      this.yaw += dyaw * (1 - Math.exp(-25 * dt));
      this.steer = lerp(this.steer, steerIn * 0.03, 1 - Math.exp(-8 * dt));
      this.idx = Math.floor(this.railS);
      this.dist += this.speed * dt;
      this.y = sy + 0.04; this.vy = 0;
      this.pitch = lerp(this.pitch, Math.atan2(ahead.y - sy, STEP), 1 - Math.exp(-10 * dt));
      this.roll = lerp(this.roll, 0, 1 - Math.exp(-10 * dt));
      this._finishPose(dt, a, 0);
      return;
    }

    // yaw / move (turn rate capped so very high speeds stay controllable)
    const yawRate = clamp(this.speed * Math.tan(this.steer) / WB, -1.6, 1.6) * (this.airborne ? 0.8 : 1);
    this.yaw -= yawRate * dt;
    const [nfx, nfz] = this.dir;
    this.pos.x += nfx * this.speed * dt;
    this.pos.z += nfz * this.speed * dt;
    this.dist += Math.abs(this.speed) * dt;

    // ground contact (4 wheels)
    const nrx = -nfz, nrz = nfx;
    const hw = TRACK / 2, hl = WB / 2;
    const hFL = w.groundAt(this.pos.x + nfx * hl - nrx * hw, this.pos.z + nfz * hl - nrz * hw);
    const hFR = w.groundAt(this.pos.x + nfx * hl + nrx * hw, this.pos.z + nfz * hl + nrz * hw);
    const hRL = w.groundAt(this.pos.x - nfx * hl - nrx * hw, this.pos.z - nfz * hl - nrz * hw);
    const hRR = w.groundAt(this.pos.x - nfx * hl + nrx * hw, this.pos.z - nfz * hl + nrz * hw);
    const ty = (hFL + hFR + hRL + hRR) / 4;
    const tPitch = Math.atan2((hFL + hFR) / 2 - (hRL + hRR) / 2, WB);
    const tRoll = this.model === 'bike' ? 0 : Math.atan2((hFL + hRL) / 2 - (hFR + hRR) / 2, TRACK);
    // gravity: on the ground vy tracks the slope; if the ground falls away faster than
    // a ballistic arc (crests, cliffs) the car takes off and drops under gravity
    const G = 14;
    const latAcc = this.airborne ? 0 : this.speed * this.speed * Math.tan(this.steer) / WB;
    if (this.airborne) {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      this.airTime += dt;
      const tp = clamp(Math.atan2(this.vy, Math.max(Math.abs(this.speed), 1)), -0.9, 0.6);
      this.pitch = lerp(this.pitch, tp, 1 - Math.exp(-2.5 * dt));
      this.roll = lerp(this.roll, 0, 1 - Math.exp(-1.5 * dt));
      if (this.y <= ty) {
        const impact = -this.vy;
        this.y = ty; this.vy = 0; this.airborne = false;
        this.landBump = Math.min(0.35, impact * 0.012);
        this.speed *= impact > 25 ? 0.85 : 0.97; // hard landings scrub some speed
        if (this.onLand) this.onLand(impact, this.airTime);
      }
    } else {
      const ballY = this.y + this.vy * dt - 0.5 * G * dt * dt;
      if (ballY > ty + 0.45 && Math.abs(this.speed) > 6) {
        this.airborne = true; this.airTime = 0;
        this.vy -= G * dt; this.y = ballY;
      } else {
        this.vy = clamp((ty - this.y) / Math.max(dt, 1e-3), -Math.abs(this.speed) - 5, Math.abs(this.speed) + 5);
        this.y = ty;
      }
      this.pitch = lerp(this.pitch, tPitch, 1 - Math.exp(-12 * dt));
      this.roll = lerp(this.roll, tRoll, 1 - Math.exp(-12 * dt));
    }
    this.landBump = (this.landBump || 0) * Math.exp(-6 * dt);
    this._finishPose(dt, a, latAcc);
  }

  _finishPose(dt, a, latAcc) {
    const night = this._night, throttle = this.throttleIn;
    let bodyRoll = clamp(-latAcc * 0.006, -0.06, 0.06);
    if (this.model === 'bike') {
      // motorbikes lean into the turn
      const target = clamp(Math.atan(latAcc / 9.81), -0.8, 0.8);
      this.lean = lerp(this.lean || 0, target, 1 - Math.exp(-6 * dt));
      bodyRoll = this.lean;
    }
    const bodyPitch = clamp(-a * 0.004, -0.04, 0.04);

    this.group.position.set(this.pos.x, this.y, this.pos.z);
    this.group.rotation.set(-this.pitch, this.yaw, this.roll, 'YXZ');
    this.body.rotation.set(bodyPitch, 0, bodyRoll);
    this.body.position.y = Math.sin(this.dist * 0.9) * 0.004 * (this.onRoad ? 0.3 : 3) - (this.landBump || 0) * Math.abs(Math.sin(performance.now() * 0.02));

    this.wheelRot = (this.wheelRot + (this.speed * dt) / WR) % (Math.PI * 2);
    for (const wh of this.wheels) {
      wh.spin.rotation.x = this.wheelRot;
      wh.pivot.rotation.y = wh.front ? -this.steer : 0;
    }

    // lights
    const n = night;
    this.headMat.emissiveIntensity = 0.4 + n * 6;
    for (const b of this.beams) b.intensity = n * 220;
    this.tailMat.emissiveIntensity = (this.braking ? 5 : 0.6) + n * 1.5;
    this.tailLight.intensity = (this.braking ? 3 : 0) + n * 1.2;

    // pseudo engine rpm with gears
    const v = Math.abs(this.speed);
    const shifts = [0, 9, 17, 26, 36, 47];
    let g = 1; for (let i = 1; i < shifts.length; i++) if (v > shifts[i]) g = i + 1;
    this.gear = g;
    const lo = shifts[g - 1], hi = shifts[g] || 62;
    const frac = clamp((v - lo) / (hi - lo), 0, 1);
    const targetRpm = 900 + frac * 4800 + (g === 1 ? 0 : 900) * (1 - frac) + throttle * 400;
    this.rpm = lerp(this.rpm, targetRpm, 1 - Math.exp(-6 * dt));
    this.throttle = throttle;
  }
}
