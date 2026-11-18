import * as THREE from 'three';

// GPU-driven rain streaks and snowflakes that wrap around the camera.
export class Precipitation {
  constructor(scene) {
    this.time = 0;
    this.camVel = new THREE.Vector3();
    this._lastCam = null;

    // ---- rain: line segments, head + tail per drop ----
    const RN = 14000, RB = new THREE.Vector3(70, 36, 70);
    {
      const pos = new Float32Array(RN * 2 * 3), end = new Float32Array(RN * 2), rnd = new Float32Array(RN * 2);
      for (let i = 0; i < RN; i++) {
        const x = (Math.random() - 0.5) * RB.x, y = (Math.random() - 0.5) * RB.y, z = (Math.random() - 0.5) * RB.z, r = Math.random();
        for (let e = 0; e < 2; e++) {
          const k = i * 2 + e;
          pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z; end[k] = e; rnd[k] = r;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
      g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
      this.rainMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        uniforms: {
          uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uFall: { value: new THREE.Vector3(0, -24, 0) },
          uStreak: { value: new THREE.Vector3(0, 1, 0) }, uAmount: { value: 0 }, uBox: { value: RB }, uColor: { value: new THREE.Color() },
        },
        vertexShader: /* glsl */`
          uniform vec3 uCam, uFall, uStreak, uBox; uniform float uTime, uAmount;
          attribute float aEnd, aRand; varying float vA;
          void main(){
            vec3 p = position + uFall * uTime * (0.85 + 0.3 * aRand);
            p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
            p += uStreak * aEnd * (0.7 + 0.6 * aRand);
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float d = length(mv.xyz);
            vA = step(aRand, uAmount) * (1.0 - aEnd * 0.85) * smoothstep(0.8, 2.5, d) * (1.0 - smoothstep(20.0, 34.0, d));
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor; varying float vA;
          void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(uColor, vA * 0.38); }`,
      });
      this.rain = new THREE.LineSegments(g, this.rainMat);
      this.rain.frustumCulled = false;
      this.rain.renderOrder = 5;
      scene.add(this.rain);
    }

    // ---- snow: soft round points ----
    const SN = 9000, SB = new THREE.Vector3(80, 40, 80);
    {
      const pos = new Float32Array(SN * 3), rnd = new Float32Array(SN);
      for (let i = 0; i < SN; i++) {
        pos[i * 3] = (Math.random() - 0.5) * SB.x; pos[i * 3 + 1] = (Math.random() - 0.5) * SB.y; pos[i * 3 + 2] = (Math.random() - 0.5) * SB.z;
        rnd[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
      this.snowMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, fog: false,
        uniforms: {
          uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uAmount: { value: 0 }, uBox: { value: SB },
          uScale: { value: 300 }, uColor: { value: new THREE.Color() }, uWind: { value: new THREE.Vector2(1.2, 0.4) },
        },
        vertexShader: /* glsl */`
          uniform vec3 uCam, uBox; uniform float uTime, uAmount, uScale; uniform vec2 uWind;
          attribute float aRand; varying float vA;
          void main(){
            float t = uTime;
            vec3 p = position + vec3(uWind.x * t + sin(t * 0.7 + aRand * 40.0) * 0.9,
                                     -t * (0.9 + aRand * 0.9),
                                     uWind.y * t + cos(t * 0.55 + aRand * 23.0) * 0.9);
            p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float d = -mv.z;
            gl_PointSize = clamp(uScale * (0.035 + 0.04 * aRand) / max(d, 0.1), 1.0, 40.0);
            vA = step(aRand, uAmount) * smoothstep(0.5, 2.0, d) * (1.0 - smoothstep(26.0, 40.0, d));
          }`,
        fragmentShader: /* glsl */`
          uniform vec3 uColor; varying float vA;
          void main(){
            float r = length(gl_PointCoord - 0.5);
            float a = smoothstep(0.5, 0.15, r) * vA;
            if (a < 0.01) discard;
            gl_FragColor = vec4(uColor, a * 0.9);
          }`,
      });
      this.snow = new THREE.Points(g, this.snowMat);
      this.snow.frustumCulled = false;
      this.snow.renderOrder = 5;
      scene.add(this.snow);
    }
  }

  update(dt, camera, rain, snow, light, viewportH) {
    this.time = (this.time + dt) % 600;
    const cp = camera.position;
    if (this._lastCam && dt > 0) this.camVel.subVectors(cp, this._lastCam).divideScalar(dt);
    this._lastCam = (this._lastCam || new THREE.Vector3()).copy(cp);

    this.rain.visible = rain > 0.01;
    if (this.rain.visible) {
      const u = this.rainMat.uniforms;
      u.uTime.value = this.time; u.uCam.value.copy(cp);
      u.uAmount.value = Math.min(1, rain);
      // streak follows the drop's velocity relative to the camera (slanted when driving)
      const rel = new THREE.Vector3(1.5, -24, 0.6).sub(this.camVel).multiplyScalar(-0.035);
      if (rel.length() > 4) rel.setLength(4);
      u.uStreak.value.copy(rel);
      u.uFall.value.set(1.5, -24, 0.6);
      const c = 0.35 + light * 0.75;
      u.uColor.value.setRGB(c * 0.85, c * 0.9, c);
    }
    this.snow.visible = snow > 0.01;
    if (this.snow.visible) {
      const u = this.snowMat.uniforms;
      u.uTime.value = this.time; u.uCam.value.copy(cp);
      u.uAmount.value = Math.min(1, snow);
      u.uScale.value = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      const c = 0.25 + light * 0.9;
      u.uColor.value.setRGB(c, c, c * 1.03);
    }
  }
}
