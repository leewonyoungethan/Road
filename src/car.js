import * as THREE from 'three';
import { clamp, lerp } from './noise.js';
import { ROAD_HALF, SHOULDER, LANE, STEP } from './world.js';

const WB = 2.62;      // wheelbase
const TRACK = 1.62;
const WR = 0.35;      // wheel radius
const RAIL = 55;      // m/s (~200 km/h): above this the car locks to the road

export const CAR_COLORS = [0xc4121e, 0x1a5fd0, 0xeceae4, 0x1a1b1e, 0x1f7a52, 0xf2a81a, 0x8a8f96, 0x6a2bd1];

export class Car {
  constructor(scene, world) {
    this.world = world;
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    scene.add(this.group);
    this._build();

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

  _build() {
    this.paint = new THREE.MeshPhysicalMaterial({ color: CAR_COLORS[0], metalness: 0.6, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.04 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x06080b, metalness: 0.9, roughness: 0.04, clearcoat: 1 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.55, metalness: 0.3 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.35, metalness: 0.5 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd6d9de, roughness: 0.12, metalness: 1 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.25, metalness: 0.9 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.9 });
    const caliper = new THREE.MeshStandardMaterial({ color: 0xd8261c, roughness: 0.4, metalness: 0.3 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf4ff, emissiveIntensity: 0.6 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x500000, emissive: 0xff1208, emissiveIntensity: 0.8 });
    const add = (geo, mat, x = 0, y = 0, z = 0, shadow = true) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z);
      m.castShadow = shadow; m.receiveShadow = true; this.body.add(m); return m;
    };

    // Lofted body: superellipse cross-sections along the length, with wheel arches cut into the floor line
    const loft = (keys, z0, z1, step, n, archFn) => {
      const lerpKey = (z, k) => {
        for (let i = 0; i < keys.length - 1; i++) {
          const a = keys[i], b = keys[i + 1];
          if (z <= b[0]) { const t = (z - a[0]) / (b[0] - a[0]); const s = t * t * (3 - 2 * t); return a[k] + (b[k] - a[k]) * s; }
        }
        return keys[keys.length - 1][k];
      };
      const R = 28, pos = [], idx = [];
      const zs = [];
      for (let z = z0; z < z1; z += step) zs.push(z);
      zs.push(z1);
      zs.forEach((z) => {
        const w = lerpKey(z, 1), top = lerpKey(z, 2);
        let bot = lerpKey(z, 3);
        if (archFn) bot = Math.max(bot, archFn(z));
        const cy = (top + bot) / 2, hh = Math.max((top - bot) / 2, 0.01);
        for (let k = 0; k < R; k++) {
          const th = (k / R) * Math.PI * 2;
          const c = Math.cos(th), sn = Math.sin(th);
          const x = w * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
          let y = cy + hh * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
          if (sn < 0) y = Math.max(y, bot); // flat floor
          pos.push(x, y, z);
        }
      });
      for (let si = 0; si < zs.length - 1; si++) for (let k = 0; k < R; k++) {
        const a = si * R + k, b = si * R + (k + 1) % R, c = a + R, d = b + R;
        idx.push(a, b, c, b, d, c);
      }
      // end caps
      const cap = (si, flip) => {
        const base = pos.length / 3; let cx = 0, cy = 0;
        for (let k = 0; k < R; k++) { cx += pos[(si * R + k) * 3]; cy += pos[(si * R + k) * 3 + 1]; }
        pos.push(cx / R, cy / R, zs[si]);
        for (let k = 0; k < R; k++) { const a = si * R + k, b = si * R + (k + 1) % R; flip ? idx.push(base, a, b) : idx.push(base, b, a); }
      };
      cap(0, true); cap(zs.length - 1, false);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx); g.computeVertexNormals();
      return g;
    };
    const fz = WB / 2 + 0.05, rz = -WB / 2 + 0.05;
    const arch = (z) => {
      let h = 0;
      for (const c of [fz, rz]) { const d = Math.abs(z - c); if (d < 0.46) h = Math.max(h, WR + Math.sqrt(0.46 * 0.46 - d * d) * 0.95); }
      return h;
    };
    //            z      halfW  top   bottom
    const bodyKeys = [
      [-2.3, 0.78, 0.74, 0.36], [-2.18, 0.9, 0.86, 0.3], [-1.85, 0.97, 0.92, 0.28], [-1.3, 0.98, 0.9, 0.28],
      [-0.7, 0.93, 0.87, 0.28], [0.1, 0.93, 0.85, 0.28], [0.8, 0.97, 0.82, 0.28], [1.5, 0.96, 0.74, 0.28],
      [2.0, 0.9, 0.64, 0.29], [2.3, 0.76, 0.52, 0.31], [2.38, 0.6, 0.44, 0.33],
    ];
    add(loft(bodyKeys, -2.3, 2.38, 0.05, 3.4, arch), this.paint);
    // greenhouse (black glass) + body-coloured roof
    const cabKeys = [[-1.75, 0.62, 0.92, 0.8], [-1.25, 0.7, 1.19, 0.8], [-0.6, 0.73, 1.3, 0.8], [0.0, 0.73, 1.31, 0.8], [0.45, 0.71, 1.21, 0.8], [1.02, 0.66, 0.9, 0.8]];
    add(loft(cabKeys, -1.75, 1.02, 0.06, 2.6), glass);
    const roofKeys = [[-0.9, 0.5, 1.272, 1.18], [-0.55, 0.58, 1.316, 1.2], [0.0, 0.58, 1.322, 1.2], [0.3, 0.52, 1.27, 1.18]];
    add(loft(roofKeys, -0.9, 0.3, 0.05, 2.6), this.paint);

    // lower trim: splitter, skirts, diffuser
    add(new THREE.BoxGeometry(1.35, 0.04, 0.22), carbon, 0, 0.3, 2.22);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.08, 0.1, 1.75), carbon, s * 0.94, 0.33, 0.0);
    add(new THREE.BoxGeometry(1.5, 0.16, 0.3), carbon, 0, 0.36, -2.18);
    for (let k = -2; k <= 2; k++) add(new THREE.BoxGeometry(0.02, 0.14, 0.28), black, k * 0.25, 0.35, -2.2, false);
    for (const s of [-1, 1]) {
      const ex = new THREE.CylinderGeometry(0.055, 0.055, 0.18, 14); ex.rotateX(Math.PI / 2);
      add(ex, chrome, s * 0.52, 0.38, -2.33, false);
      const exIn = new THREE.CylinderGeometry(0.04, 0.04, 0.02, 12); exIn.rotateX(Math.PI / 2);
      add(exIn, black, s * 0.52, 0.38, -2.42, false);
    }

    // lights: slim headlights + LED DRL, full-width tail bar
    for (const s of [-1, 1]) {
      const hl = add(new THREE.BoxGeometry(0.34, 0.05, 0.08), this.headMat, s * 0.56, 0.6, 2.18, false);
      hl.rotation.y = s * -0.28;
      const drl = add(new THREE.BoxGeometry(0.3, 0.016, 0.08), this.headMat, s * 0.58, 0.56, 2.19, false);
      drl.rotation.y = s * -0.28;
      const mir = add(new THREE.BoxGeometry(0.2, 0.08, 0.13), this.paint, s * 0.86, 0.98, 0.78);
      mir.rotation.y = s * 0.15;
      add(new THREE.BoxGeometry(0.1, 0.04, 0.04), black, s * 0.77, 0.95, 0.78, false);
    }
    add(new THREE.BoxGeometry(1.5, 0.045, 0.06), this.tailMat, 0, 0.8, -2.27, false);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.2, 0.09, 0.06), this.tailMat, s * 0.68, 0.79, -2.25, false);
    // grille
    add(new THREE.BoxGeometry(0.95, 0.12, 0.05), black, 0, 0.42, 2.34, false);
    // rear wing
    const wing = new THREE.BoxGeometry(1.74, 0.03, 0.3); wing.rotateX(-0.08);
    add(wing, carbon, 0, 1.04, -2.0);
    for (const s of [-1, 1]) {
      add(new THREE.BoxGeometry(0.04, 0.22, 0.16), carbon, s * 0.55, 0.93, -1.98);
      add(new THREE.BoxGeometry(0.02, 0.12, 0.34), carbon, s * 0.87, 1.06, -2.0);
    }

    // wheels: big multi-spoke rims with red callipers
    this.wheels = [];
    const tg = new THREE.CylinderGeometry(WR, WR, 0.27, 32, 1, true); tg.rotateZ(Math.PI / 2);
    const wall = new THREE.RingGeometry(WR * 0.74, WR, 32); wall.rotateY(Math.PI / 2);
    const lip = new THREE.TorusGeometry(WR * 0.74, 0.018, 8, 32); lip.rotateY(Math.PI / 2);
    const disc = new THREE.CylinderGeometry(WR * 0.74, WR * 0.74, 0.22, 24); disc.rotateZ(Math.PI / 2);
    const spokeG = new THREE.BoxGeometry(0.035, WR * 0.66, 0.06); spokeG.translate(0, WR * 0.36, 0);
    const hub = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 12); hub.rotateZ(Math.PI / 2);
    const cal = new THREE.BoxGeometry(0.06, 0.14, 0.22);
    for (const [x, z, front] of [[TRACK / 2, fz, true], [-TRACK / 2, fz, true], [TRACK / 2, rz, false], [-TRACK / 2, rz, false]]) {
      const side = Math.sign(x);
      const pivot = new THREE.Group(); pivot.position.set(x, WR, z);
      const c = new THREE.Mesh(cal, caliper); c.position.set(side * 0.06, 0.12, -0.08); pivot.add(c);
      const spin = new THREE.Group(); pivot.add(spin);
      const t = new THREE.Mesh(tg, tire); t.castShadow = true; spin.add(t);
      for (const sx of [-1, 1]) { const wm = new THREE.Mesh(wall, tire); wm.position.x = sx * 0.135; if (sx < 0) wm.rotation.y = Math.PI; spin.add(wm); }
      const d = new THREE.Mesh(disc, black); spin.add(d);
      const face = new THREE.Group(); face.position.x = side * 0.125; spin.add(face);
      const l = new THREE.Mesh(lip, chrome); face.add(l);
      for (let k = 0; k < 10; k++) {
        const sp = new THREE.Mesh(spokeG, rimMat); sp.rotation.x = (k / 10) * Math.PI * 2; face.add(sp);
      }
      const h = new THREE.Mesh(hub, chrome); face.add(h);
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, front });
    }

    // headlight beams + brake glow
    this.beams = [];
    for (const s of [-1, 1]) {
      const sp = new THREE.SpotLight(0xf2f6ff, 0, 100, 0.45, 0.55, 1.3);
      sp.position.set(s * 0.58, 0.62, 2.25);
      sp.target.position.set(s * 0.9, 0, 24);
      this.body.add(sp, sp.target);
      this.beams.push(sp);
    }
    this.tailLight = new THREE.PointLight(0xff2010, 0, 8, 2);
    this.tailLight.position.set(0, 0.8, -2.6);
    this.body.add(this.tailLight);
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
    const tRoll = Math.atan2((hFL + hRL) / 2 - (hFR + hRR) / 2, TRACK);
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
    const bodyRoll = clamp(-latAcc * 0.006, -0.06, 0.06);
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
