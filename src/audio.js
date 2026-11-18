// Synthesised car audio: a soft multi-harmonic engine hum, road/tyre roar, wind and rain.
export class CarAudio {
  constructor() { this.ctx = null; this.muted = false; this.volume = 0.5; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp).connect(ctx.destination);

    // ---- engine: custom harmonic wave (warm, not buzzy) ----
    const real = new Float32Array(12), imag = new Float32Array(12);
    const amps = [0, 1, 0.55, 0.42, 0.18, 0.12, 0.07, 0.05, 0.03, 0.02, 0.015, 0.01];
    for (let i = 1; i < 12; i++) imag[i] = amps[i];
    const wave = ctx.createPeriodicWave(real, imag);
    this.eng = ctx.createOscillator(); this.eng.setPeriodicWave(wave);
    this.sub = ctx.createOscillator(); this.sub.type = 'sine';
    this.engLP = ctx.createBiquadFilter(); this.engLP.type = 'lowpass'; this.engLP.Q.value = 0.7;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    const subGain = ctx.createGain(); subGain.gain.value = 0.7;
    // slow wobble so it does not sound like a test tone
    this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 7;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 1.5;
    this.lfo.connect(lfoAmt).connect(this.eng.frequency);
    this.eng.connect(this.engLP); this.sub.connect(subGain).connect(this.engLP);
    this.engLP.connect(this.engGain).connect(this.master);
    this.eng.start(); this.sub.start(); this.lfo.start();

    // ---- noise sources ----
    const len = ctx.sampleRate * 3;
    const white = ctx.createBuffer(1, len, ctx.sampleRate), brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = white.getChannelData(0), bd = brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1; wd[i] = w;
      last = (last + 0.02 * w) / 1.02; bd[i] = last * 3.5;
    }
    const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };

    // road / tyre roar
    this.roadLP = ctx.createBiquadFilter(); this.roadLP.type = 'lowpass'; this.roadLP.frequency.value = 300;
    this.roadGain = ctx.createGain(); this.roadGain.gain.value = 0;
    loop(brown).connect(this.roadLP).connect(this.roadGain).connect(this.master);

    // wind
    this.windBP = ctx.createBiquadFilter(); this.windBP.type = 'bandpass'; this.windBP.Q.value = 0.5;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    loop(white).connect(this.windBP).connect(this.windGain).connect(this.master);

    // rain hiss + low patter
    this.rainHP = ctx.createBiquadFilter(); this.rainHP.type = 'highpass'; this.rainHP.frequency.value = 1200;
    this.rainLP = ctx.createBiquadFilter(); this.rainLP.type = 'lowpass'; this.rainLP.frequency.value = 7000;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    loop(white).connect(this.rainHP).connect(this.rainLP).connect(this.rainGain).connect(this.master);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.1);
  }

  update(rpm, throttle, speed, offroad, rain = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, T = 0.08;
    const f = (rpm / 60) * 2; // 4-cylinder firing frequency
    this.eng.frequency.setTargetAtTime(f, t, T);
    this.sub.frequency.setTargetAtTime(f * 0.5, t, T);
    this.engLP.frequency.setTargetAtTime(180 + throttle * 700 + rpm * 0.08, t, T);
    this.engGain.gain.setTargetAtTime(0.05 + throttle * 0.06, t, 0.15);

    const v = Math.min(Math.abs(speed), 80); // above ~290 km/h the sound saturates
    this.roadLP.frequency.setTargetAtTime(120 + v * 6 + (offroad ? 400 : 0), t, 0.2);
    this.roadGain.gain.setTargetAtTime(Math.min(0.35, v * 0.006) + (offroad ? 0.18 * Math.min(1, v / 6) : 0), t, 0.2);
    this.windBP.frequency.setTargetAtTime(250 + v * 14, t, 0.3);
    this.windGain.gain.setTargetAtTime(Math.min(0.22, v * v * 0.00006), t, 0.3);
    this.rainGain.gain.setTargetAtTime(Math.min(0.12, rain * 0.08), t, 0.5);
  }
}
