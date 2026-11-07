// Audio procedurale (nessun file): vento, onde, uccelli, passi, salto, UI.
// Si attiva al primo gesto dell'utente (regola dei browser).
export function createAudio() {
  let ctx = null, master, windGain, waveGain, windFilter, lowpass, muted = false;
  let birdT = 3, indoor = false;

  function noiseBuffer(sec = 2) {
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function loopNoise(type, freq, q = 0.7) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer(3);
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f);
    s.start();
    return f;
  }

  function start() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.8;
    lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass"; lowpass.frequency.value = 20000;
    lowpass.connect(master); master.connect(ctx.destination);

    // vento: rumore filtrato con LFO lento
    windFilter = loopNoise("bandpass", 420, 0.5);
    windGain = ctx.createGain(); windGain.gain.value = 0.05;
    windFilter.connect(windGain); windGain.connect(lowpass);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
    const lfoG = ctx.createGain(); lfoG.gain.value = 180;
    lfo.connect(lfoG); lfoG.connect(windFilter.frequency); lfo.start();

    // onde: rumore + oscillazione di volume (~8s)
    const wf = loopNoise("lowpass", 700, 0.4);
    waveGain = ctx.createGain(); waveGain.gain.value = 0;
    const swell = ctx.createGain(); swell.gain.value = 0.5;
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.13;
    const lfo2G = ctx.createGain(); lfo2G.gain.value = 0.5;
    lfo2.connect(lfo2G); lfo2G.connect(swell.gain); lfo2.start();
    wf.connect(swell); swell.connect(waveGain); waveGain.connect(lowpass);
  }

  function burst(dur, freq, vol, type = "lowpass") {
    if (!ctx) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.3);
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(lowpass); s.start(t); s.stop(t + dur + 0.02);
  }
  function tone(f0, f1, dur, vol, type = "sine", delay = 0) {
    if (!ctx) return;
    const o = ctx.createOscillator(); o.type = type;
    const g = ctx.createGain(); const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(lowpass); o.start(t); o.stop(t + dur + 0.02);
  }

  return {
    start,
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.8;
      return muted;
    },
    get muted() { return muted; },
    step(rough = 1) { burst(0.07, 500 + Math.random() * 400, 0.09 * rough); },
    jump() { burst(0.12, 900, 0.07, "bandpass"); tone(300, 520, 0.12, 0.04); },
    land(power = 1) { burst(0.16, 280, 0.16 * power); },
    click() { tone(660, 880, 0.07, 0.07, "triangle"); },
    enter() { tone(392, 523, 0.14, 0.08, "triangle"); tone(523, 659, 0.16, 0.07, "triangle", 0.1); },
    exit() { tone(523, 392, 0.14, 0.08, "triangle"); tone(392, 294, 0.16, 0.07, "triangle", 0.1); },
    greet() { tone(523, 784, 0.12, 0.08, "triangle"); tone(784, 1047, 0.18, 0.07, "triangle", 0.12); },
    chirp() {
      const base = 2200 + Math.random() * 1400;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) tone(base, base * (1.2 + Math.random() * 0.3), 0.07, 0.025, "sine", i * 0.11);
    },
    // chiamata ogni frame: seaNear 0..1, day 0..1, dentro un edificio?
    update(dt, seaNear, day, isIndoor) {
      if (!ctx) return;
      const t = ctx.currentTime;
      waveGain.gain.setTargetAtTime(isIndoor ? 0 : 0.03 + seaNear * 0.16, t, 0.4);
      windGain.gain.setTargetAtTime(isIndoor ? 0.01 : 0.035 + (1 - seaNear) * 0.03, t, 0.5);
      if (isIndoor !== indoor) {
        indoor = isIndoor;
        lowpass.frequency.setTargetAtTime(isIndoor ? 1400 : 20000, t, 0.15);
      }
      birdT -= dt;
      if (birdT <= 0) {
        birdT = 3 + Math.random() * 6;
        if (day > 0.5 && !isIndoor && seaNear < 0.7) this.chirp();
      }
    },
  };
}
