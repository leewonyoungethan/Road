import * as THREE from 'three';
import { clamp, lerp } from './noise.js';
import { ROAD_HALF, SHOULDER, LANE, STEP } from './world.js';

const WB = 2.62;      // wheelbase
const TRACK = 1.58;
const WR = 0.34;      // wheel radius
const RAIL = 55;      // m/s (~200 km/h): above this the car locks to the road

export const CAR_COLORS = [0xb3121f, 0x1f4fa8, 0xe8e6e0, 0x1b1c1f, 0x2f6b4a, 0xe39a1c];

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
    this.paint = new THREE.MeshPhysicalMaterial({ color: CAR_COLORS[0], metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06 });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b0f14, metalness: 0.9, roughness: 0.05, clearcoat: 1 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.6, metalness: 0.2 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.18, metalness: 1 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 0.4 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1010, emissiveIntensity: 0.6 });

    const extrude = (pts, depth, mat, bevel = 0.06) => {
      const sh = new THREE.Shape();
      sh.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        if (p.length === 4) sh.quadraticCurveTo(p[0], p[1], p[2], p[3]); else sh.lineTo(p[0], p[1]);
      }
      const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10 });
      g.rotateY(-Math.PI / 2);
      g.translate(depth / 2, 0, 0);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true; m.receiveShadow = true;
      return m;
    };
    // lower body (side profile, x = length axis)
    const bodyPts = [
      [-2.18, 0.34], [2.08, 0.34], [2.26, 0.42, 2.24, 0.62], [2.2, 0.78, 1.9, 0.84],
      [0.95, 0.98], [-1.55, 1.0], [-2.12, 0.98, -2.2, 0.8], [-2.24, 0.55, -2.18, 0.34],
    ];
    this.body.add(extrude(bodyPts, 1.66, this.paint, 0.07));
    // cabin glass
    const cab = [[0.98, 0.96], [0.15, 1.38, -0.1, 1.42], [-0.95, 1.42], [-1.5, 1.38, -1.75, 1.0], [-1.55, 0.97]];
    this.body.add(extrude(cab, 1.38, glass, 0.06));
    // roof panel
    const roof = [[0.12, 1.4], [-0.98, 1.4], [-1.25, 1.38, -1.4, 1.3], [-1.3, 1.45], [-0.95, 1.5], [0.1, 1.5], [0.2, 1.46]];
    this.body.add(extrude(roof, 1.32, this.paint, 0.05));
    // B-pillars
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.46, 0.14), black);
      p.position.set(s * 0.755, 1.2, -0.42); p.rotation.x = 0.05;
      this.body.add(p);
    }
    // bumpers / grille / sills
    const fb = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.16, 0.2), black); fb.position.set(0, 0.42, 2.22); this.body.add(fb);
    const rb = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.18, 0.2), black); rb.position.set(0, 0.45, -2.22); this.body.add(rb);
    const gr = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.06), black); gr.position.set(0, 0.62, 2.29); this.body.add(gr);
    const gs = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.02, 0.07), chrome); gs.position.set(0, 0.7, 2.29); this.body.add(gs);
    for (const s of [-1, 1]) {
      const sill = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 2.5), black); sill.position.set(s * 0.88, 0.36, 0); this.body.add(sill);
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.11, 0.06), this.headMat); hl.position.set(s * 0.6, 0.68, 2.27); this.body.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.06), this.tailMat); tl.position.set(s * 0.6, 0.82, -2.25); this.body.add(tl);
      const mir = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.1, 0.16), this.paint); mir.position.set(s * 0.95, 1.02, 0.82); mir.castShadow = true; this.body.add(mir);
    }
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.02), new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.5 }));
    plate.position.set(0, 0.58, -2.34); this.body.add(plate);

    // wheels
    this.wheels = [];
    const tg = new THREE.CylinderGeometry(WR, WR, 0.24, 24); tg.rotateZ(Math.PI / 2);
    const rg = new THREE.CylinderGeometry(WR * 0.66, WR * 0.66, 0.25, 12); rg.rotateZ(Math.PI / 2);
    const sg = new THREE.BoxGeometry(0.255, 0.06, WR * 1.2);
    for (const [x, z, front] of [[TRACK / 2, WB / 2 + 0.05, true], [-TRACK / 2, WB / 2 + 0.05, true], [TRACK / 2, -WB / 2 + 0.05, false], [-TRACK / 2, -WB / 2 + 0.05, false]]) {
      const pivot = new THREE.Group(); pivot.position.set(x, WR, z);
      const spin = new THREE.Group(); pivot.add(spin);
      const t = new THREE.Mesh(tg, tire); t.castShadow = true; spin.add(t);
      const rim = new THREE.Mesh(rg, chrome); spin.add(rim);
      for (let k = 0; k < 3; k++) { const sp = new THREE.Mesh(sg, black); sp.rotation.x = (k * Math.PI) / 3; spin.add(sp); }
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, front });
    }

    // headlight beams
    this.beams = [];
    for (const s of [-1, 1]) {
      const sp = new THREE.SpotLight(0xfff2dc, 0, 90, 0.45, 0.55, 1.3);
      sp.position.set(s * 0.6, 0.7, 2.2);
      sp.target.position.set(s * 0.9, 0, 22);
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
    let a = 0;
    if (throttle > 0) {
      if (this.speed < -0.5) a += 10 * throttle;
      else a += throttle * (7.2 + boost) * clamp(1 - this.speed / maxV, 0, 1) + 0.6 * throttle * (this.speed < maxV ? 1 : 0);
    }
    if (this.speed > maxV + 1) a -= (this.speed - maxV) * 1.5;
    if (brake > 0) {
      if (this.speed > 0.3) a -= brake * (13 + boost * 1.2);
      else if (!auto) a -= brake * 4; // reverse
      else this.speed *= 0.9;
    }
    a -= 0.0011 * this.speed * Math.abs(this.speed) * Math.min(1, (58 / Math.max(limit, 1)) ** 2);
    a -= Math.sign(this.speed) * 0.18;
    if (this.airborne) a *= 0.6;
    const prev = this.speed;
    this.speed += a * dt;
    if (!auto && this.speed < -9) this.speed = -9;
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
