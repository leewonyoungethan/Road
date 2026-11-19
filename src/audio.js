// Soundscape: generative ambient music + soft wind (default), optional gentle engine, rain.
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// calm progression (D major / B minor colours), MIDI notes
const CHORDS = [
  [50, 57, 62, 64, 66, 69],
  [47, 54, 59, 62, 66, 69],
  [43, 50, 57, 59, 62, 66],
  [45, 52, 57, 61, 64, 69],
  [50, 57, 62, 66, 69, 71],
  [40, 47, 55, 59, 62, 67],
];
const MELODY = [74, 76, 78, 81, 83, 86, 88, 90, 93];

export const SOUND_MODES = ['music', 'engine', 'off'];
export const SOUND_NAMES = { music: '음악', engine: '엔진음', off: '소리 끔' };

export class CarAudio {
  constructor() {
    this.ctx = null;
    let m = null; try { m = localStorage.getItem('wr-sound'); } catch {}
    this.mode = SOUND_MODES.includes(m) ? m : 'music';
  }
  get muted() { return this.mode === 'off'; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 2.5;
    this.master = ctx.createGain();
    this.master.connect(comp).connect(ctx.destination);

    // shared reverb (generated impulse response)
    this.reverb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 5.5);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.reverb.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = 0.9;
    this.reverb.connect(wet).connect(this.master);

    // ---- music bus ----
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0;
    const musicLP = ctx.createBiquadFilter(); musicLP.type = 'lowpass'; musicLP.frequency.value = 2200;
    this.musicBus.connect(musicLP);
    musicLP.connect(this.master);
    const send = ctx.createGain(); send.gain.value = 0.65;
    musicLP.connect(send).connect(this.reverb);
    this.nextChordAt = ctx.currentTime + 0.3;
    this.nextNoteAt = ctx.currentTime + 4;
    this.chordIdx = Math.floor(Math.random() * CHORDS.length);

    // ---- engine (optional, soft) ----
    const real = new Float32Array(8), imag = new Float32Array(8);
    [0, 1, 0.45, 0.22, 0.1, 0.05, 0.03, 0.02].forEach((v, i) => { imag[i] = v; });
    this.eng = ctx.createOscillator(); this.eng.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    this.sub = ctx.createOscillator(); this.sub.type = 'sine';
    this.engLP = ctx.createBiquadFilter(); this.engLP.type = 'lowpass'; this.engLP.Q.value = 0.5;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    const subG = ctx.createGain(); subG.gain.value = 0.8;
    this.eng.connect(this.engLP); this.sub.connect(subG).connect(this.engLP);
    this.engLP.connect(this.engGain).connect(this.master);
    this.eng.start(); this.sub.start();

    // ---- noise: wind / road / rain ----
    const nlen = ctx.sampleRate * 4;
    const pink = ctx.createBuffer(1, nlen, ctx.sampleRate), brown = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const pd = pink.getChannelData(0), bd = brown.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < nlen; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      pd[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      last = (last + 0.02 * w) / 1.02; bd[i] = last * 3.5;
    }
    const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 3); return s; };
    this.windLP = ctx.createBiquadFilter(); this.windLP.type = 'lowpass'; this.windLP.frequency.value = 400;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    loop(pink).connect(this.windLP).connect(this.windGain).connect(this.master);
    this.roadLP = ctx.createBiquadFilter(); this.roadLP.type = 'lowpass'; this.roadLP.frequency.value = 200;
    this.roadGain = ctx.createGain(); this.roadGain.gain.value = 0;
    loop(brown).connect(this.roadLP).connect(this.roadGain).connect(this.master);
    this.rainBP = ctx.createBiquadFilter(); this.rainBP.type = 'bandpass'; this.rainBP.frequency.value = 3500; this.rainBP.Q.value = 0.4;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    loop(pink).connect(this.rainBP).connect(this.rainGain).connect(this.master);

    this._applyMode();
  }

  setMode(m) {
    this.mode = m;
    try { localStorage.setItem('wr-sound', m); } catch {}
    this._applyMode();
  }
  cycle() { this.setMode(SOUND_MODES[(SOUND_MODES.indexOf(this.mode) + 1) % SOUND_MODES.length]); return this.mode; }
  setMuted(m) { this.setMode(m ? 'off' : 'music'); }

  _applyMode() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.mode === 'off' ? 0 : 0.55, t, 0.3);
    this.musicBus.gain.setTargetAtTime(this.mode === 'music' ? 1 : 0, t, 1.0);
  }

  // soft pad chord with slow attack / release
  _chord(time) {
    const ctx = this.ctx, notes = CHORDS[this.chordIdx];
    this.chordIdx = (this.chordIdx + 1 + (Math.random() < 0.3 ? 1 : 0)) % CHORDS.length;
    const dur = 11;
    notes.forEach((m, k) => {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, time);
      const peak = (k === 0 ? 0.05 : 0.026) * (0.8 + Math.random() * 0.4);
      g.gain.linearRampToValueAtTime(peak, time + 3.5);
      g.gain.setValueAtTime(peak, time + dur - 4);
      g.gain.linearRampToValueAtTime(0, time + dur + 2);
      g.connect(this.musicBus);
      for (const det of [-5, 5]) {
        const o = ctx.createOscillator();
        o.type = k === 0 ? 'sine' : 'triangle';
        o.frequency.value = mtof(m); o.detune.value = det + (Math.random() - 0.5) * 4;
        o.connect(g); o.start(time); o.stop(time + dur + 2.2);
      }
    });
    return dur - 1.5;
  }

  // sparse bell-like melody note
  _note(time) {
    const ctx = this.ctx;
    const m = MELODY[Math.floor(Math.random() * MELODY.length)];
    const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = mtof(m);
    o2.type = 'sine'; o2.frequency.value = mtof(m) * 2.01;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(0.035, time + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, time + 3.5);
    o.connect(g); o2.connect(g2).connect(g); g.connect(this.musicBus);
    o.start(time); o2.start(time); o.stop(time + 3.6); o2.stop(time + 3.6);
  }

  update(rpm, throttle, speed, offroad, rain = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;

    if (this.mode === 'music') {
      if (t >= this.nextChordAt - 0.1) this.nextChordAt = this.nextChordAt + this._chord(Math.max(t, this.nextChordAt));
      if (t >= this.nextNoteAt) {
        if (Math.random() < 0.75) this._note(t + 0.05);
        this.nextNoteAt = t + 1.2 + Math.random() * 3.2;
      }
    } else {
      this.nextChordAt = Math.max(this.nextChordAt, t + 0.5);
    }

    const engine = this.mode === 'engine';
    const f = Math.min(rpm, 6500) / 60 * 2;
    this.eng.frequency.setTargetAtTime(f, t, 0.1);
    this.sub.frequency.setTargetAtTime(f * 0.5, t, 0.1);
    this.engLP.frequency.setTargetAtTime(150 + throttle * 450 + rpm * 0.05, t, 0.1);
    this.engGain.gain.setTargetAtTime(engine ? 0.035 + throttle * 0.035 : 0, t, 0.2);

    const v = Math.min(Math.abs(speed), 70);
    const amb = engine ? 1 : 0.6;
    this.windLP.frequency.setTargetAtTime(250 + v * 18, t, 0.4);
    this.windGain.gain.setTargetAtTime(amb * (0.03 + Math.min(0.2, v * v * 0.00005)), t, 0.4);
    this.roadLP.frequency.setTargetAtTime(110 + v * 4 + (offroad ? 250 : 0), t, 0.3);
    this.roadGain.gain.setTargetAtTime(amb * (Math.min(0.22, v * 0.004) + (offroad ? 0.1 * Math.min(1, v / 8) : 0)), t, 0.3);
    this.rainGain.gain.setTargetAtTime(Math.min(0.16, rain * 0.11), t, 0.6);
  }
}
