import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { World, STEP, LANE, CHUNK } from './world.js';
import { Atmosphere } from './sky.js';
import { Car, CAR_COLORS } from './car.js';
import { CarAudio, SOUND_NAMES } from './audio.js';
import { Precipitation } from './weather.js';
import { clamp, lerp, mulberry32 } from './noise.js';

// ---------------- settings ----------------
const isTouch = matchMedia('(pointer: coarse)').matches;
const DPR = devicePixelRatio || 1;
const QUALITY = {
  high: { name: '높음', pixelRatio: Math.min(DPR, 1.75), shadows: true, shadowSize: 2048, grass: true, grassCount: 8000, farSegs: 16, view: 7, bloom: true, msaa: 4 },
  medium: { name: '보통', pixelRatio: Math.min(DPR, 1.25), shadows: true, shadowSize: 1024, grass: true, grassCount: 4000, farSegs: 16, view: 6, bloom: true, msaa: 2 },
  low: { name: '낮음', pixelRatio: Math.min(DPR, 1), shadows: false, shadowSize: 512, grass: false, grassCount: 0, farSegs: 12, view: 5, bloom: false, msaa: 0 },
};
let qualityKey = (() => { try { return localStorage.getItem('wr-quality'); } catch { return null; } })() || (isTouch ? 'low' : 'medium');
if (!QUALITY[qualityKey]) qualityKey = 'high';
const quality = { ...QUALITY[qualityKey] };

const params = new URLSearchParams(location.hash.slice(1));
let seed = parseInt(params.get('seed'), 10);
if (!Number.isFinite(seed)) seed = Math.floor(Math.random() * 1e6);

// ---------------- renderer ----------------
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(quality.pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.5;
renderer.shadowMap.enabled = quality.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 20000);

const atmo = new Atmosphere(renderer, scene);
atmo.sun.castShadow = quality.shadows;
atmo.sun.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
const precip = new Precipitation(scene);

const forcedType = params.get('type');
let world = new World(seed, scene, quality, forcedType);
const car = new Car(scene, world);

// ---------------- water ----------------
function makeWaterNormals() {
  const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d'); const img = g.createImageData(S, S);
  const r = mulberry32(7);
  const waves = [];
  for (let i = 0; i < 14; i++) waves.push([Math.floor(r() * 9) - 4 || 1, Math.floor(r() * 9) - 4, r() * 6.28, 1 / (1 + i * 0.6)]);
  const h = (x, y) => { let s = 0; for (const [a, b, p, w] of waves) s += Math.sin((a * x + b * y) * 2 * Math.PI / S + p) * w; return s; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
    const nx = -dx * 2, ny = -dy * 2, nz = 1, l = Math.hypot(nx, ny, nz);
    const i = (y * S + x) * 4;
    img.data[i] = (nx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (ny / l * 0.5 + 0.5) * 255; img.data[i + 2] = (nz / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
}
const waterNormals = makeWaterNormals();
const waterNormals2 = waterNormals.clone();
const WATER_SIZE = 24000, WATER_TILE = 64;
waterNormals.repeat.set(WATER_SIZE / WATER_TILE, WATER_SIZE / WATER_TILE);
waterNormals2.repeat.set(WATER_SIZE / (WATER_TILE * 2.7), WATER_SIZE / (WATER_TILE * 2.7));
const waterMat = new THREE.MeshPhysicalMaterial({
  color: 0x06222c, roughness: 0.1, metalness: 0, normalMap: waterNormals, normalScale: new THREE.Vector2(0.12, 0.12),
  envMapIntensity: 0.75, transparent: true, opacity: 0.9, ior: 1.33, specularIntensity: 0.6,
});
const waterGeo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, 1, 1); waterGeo.rotateX(-Math.PI / 2);
const water = new THREE.Mesh(waterGeo, waterMat);
water.receiveShadow = true;
water.position.y = 0;
scene.add(water);

// ---------------- post processing ----------------
let composer, bloom;
function setupComposer() {
  const rt = new THREE.WebGLRenderTarget(innerWidth * quality.pixelRatio, innerHeight * quality.pixelRatio, { type: THREE.HalfFloatType, samples: quality.msaa });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(quality.pixelRatio);
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.55, 0.92);
  bloom.enabled = quality.bloom;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uVig: { value: 0.32 }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig, uTime; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){ vec4 c = texture2D(tDiffuse, vUv);
        vec2 d = vUv - 0.5; float v = 1.0 - dot(d, d) * uVig * 2.0;
        c.rgb *= v;
        c.rgb = mix(c.rgb, c.rgb * c.rgb * (3.0 - 2.0 * c.rgb), 0.18);  // gentle contrast curve
        c.rgb += (h(vUv * 1000.0 + uTime) - 0.5) / 255.0 * 2.0;      // dither
        gl_FragColor = c; }`,
  }));
}
setupComposer();

// ---------------- input ----------------
const keys = new Set();
const input = { throttle: 0, brake: 0, steer: 0 };
let autoDrive = true;
let camMode = 0; // 0 chase, 1 hood, 2 cinematic, 3 top
const CAM_NAMES = ['추격', '보닛', '시네마틱', '항공'];
let timeFlow = false;
let hudHidden = false;
const TIME_PRESETS = [6.4, 9.5, 13, 16.4, 17.55, 18.05, 23.5];
let presetIdx = 4;
atmo.setTime(TIME_PRESETS[presetIdx]);
const WEATHERS = ['clear', 'fair', 'cloudy', 'rain', 'storm', 'snow'];
const WEATHER_NAMES = { clear: '맑음', fair: '구름 조금', cloudy: '흐림', rain: '비', storm: '폭우', snow: '눈' };
let weatherIdx = 1;
atmo.setWeather(WEATHERS[weatherIdx]);
let colorIdx = 0;
const audio = new CarAudio();

addEventListener('keydown', (e) => {
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);
  switch (e.code) {
    case 'KeyE': case 'Digit1': toggleAuto(); break;
    case 'KeyC': cycleCam(); break;
    case 'KeyT': cycleTime(); break;
    case 'KeyR': resetCar(); break;
    case 'KeyM': toggleMute(); break;
    case 'KeyH': hudHidden = !hudHidden; document.body.classList.toggle('nohud', hudHidden); break;
    case 'KeyP': cycleClouds(); break;
    case 'KeyK': cycleColor(); break;
    case 'KeyL': timeFlow = !timeFlow; toast(timeFlow ? '시간 흐름 켜짐' : '시간 흐름 꺼짐'); break;
    case 'KeyN': newWorld(); break;
    case 'Equal': case 'NumpadAdd': setSpeedKmh(speedKmh * 1.15); break;
    case 'Minus': case 'NumpadSubtract': setSpeedKmh(speedKmh / 1.15); break;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  // any manual drive key takes over from autopilot
  if (autoDrive && ['KeyW', 'ArrowUp', 'KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'].includes(e.code)) { toggleAuto(); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// mouse orbit for chase cam
let orbit = 0, orbitPitch = 0, dragging = false, lastX = 0, lastY = 0, orbitTimer = 0;
canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') return; dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (!dragging) return;
  orbit -= (e.clientX - lastX) * 0.006; orbitPitch = clamp(orbitPitch + (e.clientY - lastY) * 0.004, -0.3, 0.9);
  lastX = e.clientX; lastY = e.clientY; orbitTimer = 3;
});

// touch controls
const touch = { left: false, right: false, gas: false, brake: false };
document.querySelectorAll('[data-touch]').forEach((el) => {
  const k = el.dataset.touch;
  const on = (e) => { e.preventDefault(); touch[k] = true; el.classList.add('on'); if (autoDrive && k !== 'brake') toggleAuto(); };
  const off = (e) => { e.preventDefault(); touch[k] = false; el.classList.remove('on'); };
  el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
});

function readInput() {
  const k = (c) => keys.has(c);
  input.throttle = (k('KeyW') || k('ArrowUp') || touch.gas) ? 1 : 0;
  input.brake = (k('KeyS') || k('ArrowDown') || k('Space') || touch.brake) ? 1 : 0;
  input.steer = ((k('KeyD') || k('ArrowRight') || touch.right) ? 1 : 0) - ((k('KeyA') || k('ArrowLeft') || touch.left) ? 1 : 0);
}

// ---------------- UI ----------------
const $ = (id) => document.getElementById(id);
const ui = {
  speed: $('speed'), gear: $('gear'), dist: $('dist'), clock: $('clock'), mode: $('mode'),
  auto: $('btn-auto'), cam: $('btn-cam'), time: $('btn-time'), sound: $('btn-sound'), qual: $('btn-quality'),
  clouds: $('btn-clouds'), slider: $('speed-slider'), speedSet: $('speed-set'), color: $('btn-color'), seed: $('seed'), toast: $('toast'), loading: $('loading'), bar: $('bar'),
};
function toast(msg) {
  ui.toast.textContent = msg; ui.toast.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => ui.toast.classList.remove('show'), 1600);
}
function toggleAuto() { autoDrive = !autoDrive; refreshUI(); toast(autoDrive ? '자동 주행 켜짐 — 편하게 감상하세요' : '수동 주행 — W/A/S/D 또는 방향키'); }
function cycleCam() { camMode = (camMode + 1) % CAM_NAMES.length; cine.idx = -1; refreshUI(); toast(`카메라: ${CAM_NAMES[camMode]}`); }
function cycleTime() { presetIdx = (presetIdx + 1) % TIME_PRESETS.length; timeTarget = TIME_PRESETS[presetIdx]; refreshUI(); }
function cycleClouds() { setWeather((weatherIdx + 1) % WEATHERS.length); }
function setWeather(i) {
  weatherIdx = i; atmo.setWeather(WEATHERS[i]);
  toast(`날씨: ${WEATHER_NAMES[WEATHERS[i]]}`); refreshUI();
}
function cycleColor() { colorIdx = (colorIdx + 1) % CAR_COLORS.length; car.setColor(CAR_COLORS[colorIdx]); }
function toggleMute() { const m = audio.cycle(); refreshUI(); toast(`소리: ${SOUND_NAMES[m]}`); }
function resetCar() { car.placeOnRoad(car.idx + 2); toast('도로로 복귀'); }
function setQuality(k) {
  try { localStorage.setItem('wr-quality', k); } catch {}
  location.hash = `seed=${seed}` + (forcedType ? `&type=${forcedType}` : '');
  location.reload();
}
function newWorld() {
  seed = Math.floor(Math.random() * 1e6);
  location.hash = `seed=${seed}`;
  location.reload();
}
function refreshUI() {
  ui.auto.classList.toggle('active', autoDrive);
  ui.auto.querySelector('span').textContent = autoDrive ? '자동 주행' : '수동 주행';
  ui.cam.querySelector('span').textContent = CAM_NAMES[camMode];
  ui.sound.querySelector('span').textContent = SOUND_NAMES[audio.mode];
  ui.qual.querySelector('span').textContent = `화질 ${quality.name}`;
  ui.mode.textContent = autoDrive ? 'AUTO' : 'MANUAL';
  ui.clouds.querySelector('span').textContent = WEATHER_NAMES[WEATHERS[weatherIdx]];
  document.body.classList.toggle('manual', !autoDrive);
}
ui.auto.onclick = toggleAuto; ui.cam.onclick = cycleCam; ui.time.onclick = cycleTime; ui.sound.onclick = toggleMute;
ui.clouds.onclick = cycleClouds; ui.color.onclick = cycleColor;
ui.qual.onclick = () => { const order = ['high', 'medium', 'low']; setQuality(order[(order.indexOf(qualityKey) + 1) % 3]); };
$('btn-new').onclick = newWorld;
ui.seed.textContent = `#${seed} · ${world.typeName}`;
document.querySelectorAll('[data-wtype]').forEach((b) => {
  const t = b.dataset.wtype;
  b.classList.toggle('active', t === (forcedType || ''));
  b.onclick = () => { seed = Math.floor(Math.random() * 1e6); location.hash = `seed=${seed}` + (t ? `&type=${t}` : ''); location.reload(); };
});
$('wname').textContent = world.typeName;
$('start').onclick = () => {
  document.body.classList.add('playing');
  audio.start();
  refreshUI();
};
refreshUI();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------------- camera ----------------
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camOff = new THREE.Vector3(0, 3, -8);
let camYaw = 0, camInit = false;
const cine = { idx: -1, pos: new THREE.Vector3(), tmp: { x: 0, y: 0, z: 0, fx: 0, fz: 1 } };
const v3 = new THREE.Vector3();

function updateCamera(dt) {
  const [fx, fz] = car.dir;
  const cp = car.group.position;
  if (!camInit) { camYaw = car.yaw; camPos.set(cp.x - fx * 8, cp.y + 3, cp.z - fz * 8); camLook.copy(cp); camInit = true; }
  let ang = camYaw - car.yaw; ang = Math.atan2(Math.sin(ang), Math.cos(ang));
  camYaw = car.yaw + ang * Math.exp(-dt * 3.2);
  orbitTimer -= dt;
  if (orbitTimer < 0 && !dragging) { orbit *= Math.exp(-dt * 1.5); orbitPitch *= Math.exp(-dt * 1.5); }
  let fov = 60;

  if (camMode === 0) {
    const a = camYaw + orbit;
    const dist = 7.4 + Math.abs(car.speed) * 0.02, height = 2.3 + orbitPitch * 6;
    v3.set(cp.x - Math.sin(a) * dist, cp.y + height, cp.z - Math.cos(a) * dist);
    const gmin = world.groundAt(v3.x, v3.z) + 0.8;
    if (v3.y < gmin) v3.y = gmin;
    v3.sub(cp);
    camOff.lerp(v3, 1 - Math.exp(-dt * 10));
    camPos.copy(cp).add(camOff);
    camLook.set(cp.x + fx * 4, cp.y + 1.1, cp.z + fz * 4);
    const sp = Math.abs(car.speed);
    fov = 58 + 14 * Math.min(1, sp / 56) + 18 * Math.min(1, Math.max(0, sp - 56) / 700);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  } else if (camMode === 1) {
    v3.set(0, 1.38, 0.9); car.body.localToWorld(v3);
    camera.position.copy(v3);
    const t = new THREE.Vector3(0, 0.6, 40); car.body.localToWorld(t);
    camera.lookAt(t);
    fov = 68;
  } else if (camMode === 2) {
    // roadside cinematic shots
    if (cine.idx < 0 || car.idx > cine.idx + 12 + Math.abs(car.speed) * 0.15 || car.idx < cine.idx - 140 * Math.max(1, Math.abs(car.speed) / 25)) {
      cine.idx = car.idx + Math.floor((40 + Math.random() * 40) * Math.max(1, Math.abs(car.speed) / 25));
      const s = world.sample(cine.idx, cine.tmp);
      const side = Math.random() < 0.5 ? -1 : 1;
      const off = side * (9 + Math.random() * 14);
      const x = s.x - s.fz * off, z = s.z + s.fx * off;
      cine.pos.set(x, Math.max(world.heightAt(x, z), 0.2) + 1.2 + Math.random() * 6, z);
    }
    camera.position.copy(cine.pos);
    v3.set(cp.x, cp.y + 0.8, cp.z);
    camera.lookAt(v3);
    const d = cine.pos.distanceTo(cp);
    fov = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(7 / d)), 12, 60);
  } else {
    const a = camYaw + orbit;
    v3.set(cp.x - Math.sin(a) * 28, cp.y + 26 + orbitPitch * 20, cp.z - Math.cos(a) * 28);
    v3.sub(cp);
    camOff.lerp(v3, 1 - Math.exp(-dt * 4));
    camPos.copy(cp).add(camOff);
    camera.position.copy(camPos);
    camLook.set(cp.x + fx * 14, cp.y, cp.z + fz * 14);
    camera.lookAt(camLook);
    fov = 50;
  }
  camera.fov = lerp(camera.fov, fov, camMode === 2 ? 1 : 1 - Math.exp(-dt * 3));
  camera.updateProjectionMatrix();
}

// ---------------- boot ----------------
const START_IDX = 160;
world.ensureRoad(START_IDX * STEP + quality.view * CHUNK + 400);
car.placeOnRoad(START_IDX, LANE);
car.onLand = (impact, t) => { if (t > 1.2) toast(`${t.toFixed(1)}초 비행 — 착지!`); };
let speedKmh = (() => { try { return parseFloat(localStorage.getItem('wr-speed')); } catch { return NaN; } })();
if (!Number.isFinite(speedKmh)) speedKmh = 80;
function setSpeedKmh(v, silent) {
  speedKmh = clamp(Math.round(v), 20, 4000);
  car.autoSpeed = speedKmh / 3.6;
  ui.speedSet.textContent = speedKmh;
  ui.slider.value = String(Math.log(speedKmh / 20) / Math.log(200) * 1000);
  try { localStorage.setItem('wr-speed', String(speedKmh)); } catch {}
  if (!silent) toast(`목표 속도 ${speedKmh} km/h`);
}
ui.slider.addEventListener('input', () => setSpeedKmh(20 * Math.pow(200, ui.slider.value / 1000), true));
ui.slider.addEventListener('pointerdown', (e) => e.stopPropagation());
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeedKmh(+b.dataset.speed)));
setSpeedKmh(speedKmh, true);

let loaded = false;
let timeTarget = atmo.time;
const clock = new THREE.Clock();
let fpsAcc = -3, fpsN = 0, lowFps = 0, dynScale = 1;
function applyScale() {
  const pr = quality.pixelRatio * dynScale;
  renderer.setPixelRatio(pr); composer.setPixelRatio(pr); composer.setSize(innerWidth, innerHeight);
}

function frame() {
  requestAnimationFrame(frame);
  let dt = Math.min(clock.getDelta(), 0.05);

  if (!loaded) {
    const rem = world.update(car.pos.x, car.pos.z, car.idx, 60, quality.view);
    precip.update(0.016, camera, 0, 0, 1, renderer.domElement.height);
    const total = world.chunks.size + rem;
    ui.bar.style.width = `${(world.chunks.size / Math.max(total, 1)) * 100}%`;
    if (rem === 0) { loaded = true; ui.loading.classList.add('done'); }
    car.update(0.016, input, true, atmo.night || 0);
    atmo.update(0.016, camera, car.group.position);
    updateCamera(0.016);
    composer.render();
    return;
  }

  const playing = document.body.classList.contains('playing');
  readInput();
  if (!playing) { input.throttle = 0; input.brake = 0; input.steer = 0; }

  // time of day
  if (timeFlow) timeTarget += dt / 60; // 1 game hour per minute
  let diff = timeTarget - atmo.time; diff = ((diff + 12) % 24 + 24) % 24 - 12;
  atmo.setTime(atmo.time + diff * (timeFlow ? 1 : 1 - Math.exp(-dt * 1.5)));
  if (Math.abs(diff) < 0.001 && !timeFlow) atmo.setTime(timeTarget);

  car.update(dt, input, autoDrive && playing ? true : autoDrive, atmo.night || 0);
  world.sharedUniforms.uTime.value += dt;
  {
    const sp = Math.max(0, car.speed), [fx, fz] = car.dir, ahead = Math.min(sp * 0.7, 520);
    world.update(car.pos.x + fx * ahead, car.pos.z + fz * ahead, car.idx, 5, quality.view, sp > 140 ? 2 : sp > 70 ? 1 : 0);
  }
  atmo.update(dt, camera, car.group.position);
  world.sharedUniforms.uSnow.value = atmo.w.snowCover * 0.95;
  world.setWetness(atmo.w.wet);
  precip.update(dt, camera, atmo.w.rain, atmo.w.snow, atmo.light, renderer.domElement.height);
  updateCamera(dt);

  water.position.x = Math.round(camera.position.x / WATER_TILE) * WATER_TILE;
  water.position.z = Math.round(camera.position.z / WATER_TILE) * WATER_TILE;
  const wt = world.sharedUniforms.uTime.value;
  waterNormals.offset.set(wt * 0.004, wt * 0.002);
  waterNormals2.offset.set(-wt * 0.0015, wt * 0.003);

  audio.update(car.rpm, car.throttle || 0, car.speed, !car.onRoad, atmo.w.rain);

  // HUD
  const kmh = Math.abs(car.speed) * 3.6;
  ui.speed.textContent = Math.round(kmh);
  ui.gear.textContent = car.speed < -0.3 ? 'R' : car.speed < 0.3 ? 'N' : car.gear;
  ui.dist.textContent = (car.dist / 1000).toFixed(1);
  const hh = Math.floor(atmo.time), mm = Math.floor((atmo.time - hh) * 60);
  ui.clock.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  composer.passes[composer.passes.length - 1].uniforms.uTime.value = wt % 100;
  composer.render();

  // adaptive hint
  fpsAcc += dt; if (fpsAcc > 0) fpsN++; else fpsN = 0;
  if (fpsAcc > 2) {
    const fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    // dynamic resolution: trade sharpness for smoothness automatically
    if (fps < 45 && dynScale > 0.55) { dynScale = Math.max(0.55, dynScale - 0.15); applyScale(); }
    else if (fps > 58 && dynScale < 1) { dynScale = Math.min(1, dynScale + 0.1); applyScale(); }
    if (fps < 25 && dynScale <= 0.56 && qualityKey !== 'low') { lowFps++; if (lowFps === 2) toast('여전히 느리면 화질 버튼으로 낮춰보세요'); }
  }
}
frame();

// expose for debugging
window.__wr = { world, car, atmo, camera, renderer, scene, setTime: (t) => { timeTarget = t; atmo.setTime(t); }, setWeather, setSpeedKmh, precip };
