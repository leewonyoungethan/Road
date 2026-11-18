// Tiny synthesized engine + wind audio
export class CarAudio {
  constructor() { this.ctx = null; this.muted = false; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(ctx.destination);

    // engine: two detuned oscillators -> lowpass
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator(); this.o2.type = 'square';
    this.o3 = ctx.createOscillator(); this.o3.type = 'sine';
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.Q.value = 2.5;
    this.eg = ctx.createGain(); this.eg.gain.value = 0.0;
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    const g3 = ctx.createGain(); g3.gain.value = 0.8;
    this.o1.connect(this.lp); this.o2.connect(g2).connect(this.lp); this.o3.connect(g3).connect(this.lp);
    this.lp.connect(this.eg).connect(this.master);
    this.o1.start(); this.o2.start(); this.o3.start();

    // wind / road noise
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
    this.noise = ctx.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true;
    this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass'; this.bp.Q.value = 0.6;
    this.ng = ctx.createGain(); this.ng.gain.value = 0;
    this.noise.connect(this.bp).connect(this.ng).connect(this.master);
    this.noise.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.1);
  }

  update(rpm, throttle, speed, offroad) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = rpm / 60 * 2; // 4-cyl firing frequency
    this.o1.frequency.setTargetAtTime(f, t, 0.05);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.o3.frequency.setTargetAtTime(f * 0.25, t, 0.05);
    this.lp.frequency.setTargetAtTime(300 + throttle * 900 + rpm * 0.12, t, 0.08);
    this.eg.gain.setTargetAtTime(0.06 + throttle * 0.07, t, 0.1);
    const v = Math.abs(speed);
    this.bp.frequency.setTargetAtTime(400 + v * 25 + (offroad ? 300 : 0), t, 0.2);
    this.ng.gain.setTargetAtTime(Math.min(0.5, v * v * 0.00018 + (offroad ? 0.15 * Math.min(1, v / 8) : 0)), t, 0.2);
  }
}
