import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { clamp, lerp, smoothstep } from './noise.js';

const SKY_PARAMS = { turbidity: 2.4, rayleigh: 2.4, mieCoefficient: 0.004, mieDirectionalG: 0.82 };

export class Atmosphere {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;

    this.sky = new Sky();
    this.sky.scale.setScalar(8000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(1000);
    this.envScene.add(this.envSky);
    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      for (const k in SKY_PARAMS) u[k].value = SKY_PARAMS[k];
    }
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envRT = null;

    this.sunDir = new THREE.Vector3();
    this.lightDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 800;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x8fa8d8, 0x2a2418, 0.0);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(0xbfd0e0, 0.00052);

    // probe to match fog colour to the sky horizon
    this.probeRT = new THREE.WebGLRenderTarget(8, 8, { type: THREE.FloatType });
    this.probeCam = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.probeBuf = new Float32Array(8 * 8 * 4);

    this._makeClouds();
    this._makeStars();

    this.time = 17.2;
    this.w = { cover: 0.38, overcast: 0, fogMul: 1, rain: 0, snow: 0, wet: 0, snowCover: 0 };
    this.wt = { ...this.w };
    this.weatherName = 'fair';
    this.baseFog = 0.00052;
    this.ring = Array.from({ length: 8 }, () => new THREE.Color(0.7, 0.75, 0.8));
    this._grey = new THREE.Color();
    this._lastEnvTime = -100; this._lastOc = 0; this._bakeCooldown = 0;
    this._fogTarget = new THREE.Color(0xbfd0e0);
  }

  _makeClouds() {
    const geo = new THREE.PlaneGeometry(36000, 36000, 1, 1);
    geo.rotateX(Math.PI / 2);
    this.cloudMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      uniforms: {
        uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
        uSkyColor: { value: new THREE.Color() }, uCover: { value: 0.5 }, uCam: { value: new THREE.Vector2() },
        uNight: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vP; varying vec3 vDir;
        uniform vec2 uCam;
        void main(){
          vec4 wp = modelMatrix * vec4(position,1.0);
          vP = position.xz + uCam;
          vDir = wp.xyz - cameraPosition;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vP; varying vec3 vDir;
        uniform float uTime, uCover, uNight; uniform vec3 uSunDir, uSunColor, uSkyColor;
        float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float noise(vec2 x){ vec2 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float s=0., a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6); for(int i=0;i<6;i++){ s+=a*noise(p); p=m*p; a*=.5; } return s; }
        void main(){
          vec2 p = mod(vP, 400000.0) * 0.00022 + vec2(uTime*0.004, uTime*0.0015);
          float n = fbm(p);
          float lo = 1.0 - uCover;
          float d = smoothstep(lo, lo + 0.22, n);
          if (d < 0.003) discard;
          float n2 = fbm(p + uSunDir.xz * 0.05);
          float shade = clamp(1.0 - (n2 - n) * 6.0 - d * 0.35, 0.0, 1.0);
          vec3 dir = normalize(vDir);
          float sunFacing = pow(max(dot(dir, uSunDir), 0.0), 6.0);
          vec3 lit = uSunColor * (0.7 + 1.2 * sunFacing);
          vec3 col = mix(uSkyColor * 0.95, lit, 0.35 + shade * 0.65);
          col = mix(col, vec3(0.012, 0.016, 0.03), uNight);
          float dist = length(vDir.xz);
          float fade = 1.0 - smoothstep(5000.0, 16000.0, dist);
          gl_FragColor = vec4(col, d * fade * 0.85);
        }`,
    });
    this.clouds = new THREE.Mesh(geo, this.cloudMat);
    this.clouds.position.y = 1500;
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -5;
    this.scene.add(this.clouds);
  }

  _makeStars() {
    const N = 2500, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.05;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(a) * r * 9000; pos[i * 3 + 1] = y * 9000; pos[i * 3 + 2] = Math.sin(a) * r * 9000;
      const b = Math.pow(Math.random(), 3) * 2.5 + 0.3;
      const tint = Math.random();
      col[i * 3] = b * (0.85 + tint * 0.15); col[i * 3 + 1] = b * 0.9; col[i * 3 + 2] = b * (1.0 - tint * 0.1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({ size: 1.8, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -8;
    this.scene.add(this.stars);
  }

  setTime(t) { this.time = ((t % 24) + 24) % 24; }

  _computeSun() {
    const t = this.time;
    const elev = THREE.MathUtils.degToRad(58) * Math.sin(((t - 6) / 12) * Math.PI);
    const az = THREE.MathUtils.degToRad((18 - t) * 15 + 15);
    this.sunDir.set(Math.cos(elev) * Math.sin(az), Math.sin(elev), Math.cos(elev) * Math.cos(az));
    return elev;
  }

  // weather presets: cover, overcast (greyness), fog multiplier, rain, snow
  setWeather(name) {
    const P = {
      clear: [0.18, 0, 1, 0, 0],
      fair: [0.38, 0, 1, 0, 0],
      cloudy: [0.68, 0.45, 1.5, 0, 0],
      rain: [0.9, 0.85, 2.6, 1, 0],
      storm: [0.97, 1, 3.4, 1.6, 0],
      snow: [0.9, 0.75, 3.0, 0, 1],
    }[name] || [0.38, 0, 1, 0, 0];
    const t = this.wt;
    [t.cover, t.overcast, t.fogMul, t.rain, t.snow] = P;
    this.weatherName = name;
  }

  _bake() {
    for (const k in SKY_PARAMS) this.envSky.material.uniforms[k].value = this.sky.material.uniforms[k].value;
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    // sample the horizon colour in 8 directions once (no per-frame GPU sync)
    const pc = this.probeCam, prev = this.renderer.getRenderTarget();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      pc.position.set(0, 0, 0);
      pc.lookAt(Math.sin(a), 0.06, Math.cos(a));
      pc.updateMatrixWorld();
      this.renderer.setRenderTarget(this.probeRT);
      this.renderer.render(this.envScene, pc);
      this.renderer.readRenderTargetPixels(this.probeRT, 0, 0, 8, 8, this.probeBuf);
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < 64; i++) { r += this.probeBuf[i * 4]; g += this.probeBuf[i * 4 + 1]; b += this.probeBuf[i * 4 + 2]; }
      if (!Number.isFinite(r)) r = g = b = 0.5 * 64;
      this.ring[k].setRGB(Math.max(r / 64, 0.006), Math.max(g / 64, 0.009), Math.max(b / 64, 0.018));
    }
    this.renderer.setRenderTarget(prev);
  }

  update(dt, camera, focus) {
    const elev = this._computeSun();
    const se = Math.sin(elev);
    const day = smoothstep(-0.06, 0.08, se);
    this.night = 1 - smoothstep(-0.18, -0.02, se);

    // ease weather towards its target
    const w = this.w, t = this.wt;
    const ease = (k, rate) => { w[k] += (t[k] - w[k]) * (1 - Math.exp(-dt * rate)); };
    ease('cover', 0.25); ease('overcast', 0.25); ease('fogMul', 0.3); ease('rain', 0.4); ease('snow', 0.4);
    w.wet += ((t.rain > 0 ? 1 : 0) - w.wet) * (1 - Math.exp(-dt * (t.rain > 0 ? 0.15 : 0.05)));
    w.snowCover += ((t.snow > 0 ? 1 : 0) - w.snowCover) * (1 - Math.exp(-dt * (t.snow > 0 ? 0.08 : 0.06)));
    const oc = w.overcast;

    for (const s of [this.sky, this.envSky]) s.material.uniforms.sunPosition.value.copy(this.sunDir);
    const su = this.sky.material.uniforms;
    su.turbidity.value = lerp(SKY_PARAMS.turbidity, 16, oc);
    su.rayleigh.value = lerp(SKY_PARAMS.rayleigh, 0.35, oc);
    su.mieCoefficient.value = lerp(SKY_PARAMS.mieCoefficient, 0.002, oc);
    this.sky.position.copy(camera.position);

    // sun / moon light
    const warm = smoothstep(0.0, 0.45, se);
    this.sunColor.setRGB(1.0, lerp(0.48, 0.96, warm), lerp(0.22, 0.9, warm));
    if (day > 0.001) {
      this.lightDir.copy(this.sunDir);
      if (this.lightDir.y < 0.05) this.lightDir.y = 0.05;
      this.lightDir.normalize();
      this.sun.color.copy(this.sunColor).lerp(new THREE.Color(0.8, 0.85, 0.95), oc);
      this.sun.intensity = day * 3.4 * (1 - oc * 0.8);
    } else {
      this.lightDir.set(-this.sunDir.x, Math.max(0.35, -this.sunDir.y), -this.sunDir.z).normalize();
      this.sun.color.setRGB(0.55, 0.65, 1.0);
      this.sun.intensity = (0.15 + 0.45 * this.night) * (1 - oc * 0.7);
    }
    this.hemi.intensity = 0.08 + this.night * 0.7 * (1 - oc * 0.5) + (1 - day) * 0.35 + oc * day * 1.1;
    this.hemi.color.setRGB(lerp(0.55, 0.25, this.night), lerp(0.65, 0.32, this.night), lerp(0.85, 0.6, this.night));

    const texel = 140 / 2048;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.lightDir.x * 400, focus.y + this.lightDir.y * 400, fz + this.lightDir.z * 400);
    this.sun.target.updateMatrixWorld();

    // re-bake environment when sun or weather changed (rate limited)
    this._bakeCooldown -= dt;
    if (this._bakeCooldown <= 0 && (Math.abs(this.time - this._lastEnvTime) > 0.08 || Math.abs(oc - this._lastOc) > 0.04)) {
      this._lastEnvTime = this.time; this._lastOc = oc; this._bakeCooldown = 0.5;
      this._bake();
    }
    this.scene.environmentIntensity = lerp(0.25, 1.0, day) * (1 - oc * 0.35);

    // fog colour: interpolate the horizon ring by view yaw, grey it out with overcast
    const f = new THREE.Vector3(); camera.getWorldDirection(f);
    let a = Math.atan2(f.x, f.z); if (a < 0) a += Math.PI * 2;
    const u = (a / (Math.PI * 2)) * 8, k0 = Math.floor(u) % 8, k1 = (k0 + 1) % 8;
    this._fogTarget.copy(this.ring[k0]).lerp(this.ring[k1], u - Math.floor(u));
    const lum = this._fogTarget.r * 0.3 + this._fogTarget.g * 0.55 + this._fogTarget.b * 0.15;
    this._grey.setRGB(lum * 0.78, lum * 0.82, lum * 0.88);
    this._fogTarget.lerp(this._grey, Math.min(1, oc * 1.1));
    if (w.snow > 0.01) this._fogTarget.multiplyScalar(1 + w.snow * 0.15);
    this.scene.fog.color.lerp(this._fogTarget, 1 - Math.exp(-dt * 4));
    this.scene.fog.density = this.baseFog * w.fogMul;

    // clouds & stars
    const cu = this.cloudMat.uniforms;
    cu.uTime.value += dt;
    cu.uSunDir.value.copy(this.sunDir);
    cu.uSunColor.value.copy(this.sunColor).multiplyScalar(lerp(0.15, 2.2, day) * (1 - oc * 0.7));
    cu.uSkyColor.value.copy(this.scene.fog.color).multiplyScalar(1 - oc * 0.25);
    cu.uCover.value = w.cover;
    cu.uNight.value = this.night * 0.92;
    this.clouds.position.x = camera.position.x; this.clouds.position.z = camera.position.z;
    cu.uCam.value.set(camera.position.x, camera.position.z);
    this.stars.position.copy(camera.position);
    this.starMat.opacity = this.night * (1 - smoothstep(0.5, 0.85, w.cover));
    this.light = day * (1 - oc * 0.6) + this.night * 0.08 + 0.04; // rough scene brightness for particles
  }
}
