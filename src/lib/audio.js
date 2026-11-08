// Audio procedurale (nessun file): ambiente (vento, onde, uccelli), effetti (passi, salto, UI)
// e musica ambient generativa. Tre canali indipendenti, ognuno con il proprio mute.
export function createAudio() {
  let ctx = null, master, lowpass, ambBus, sfxBus, musBus, windGain, waveGain, windFilter, echoIn;
  const on = { music: true, sfx: true, amb: true };
  const LEVEL = { music: 0.5, sfx: 1, amb: 1 };
  let birdT = 3, indoor = false;
  let chordT = 0, chordI = 0, pluckT = 4;

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
  const bus = (n) => (n === "music" ? musBus : n === "amb" ? ambBus : sfxBus);
  function applyBus(n) {
    if (!ctx) return;
    bus(n).gain.setTargetAtTime(on[n] ? LEVEL[n] : 0, ctx.currentTime, 0.15);
  }

  function start() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9;
    lowpass = ctx.createBiquadFilter(); lowpass.type = "lowpass"; lowpass.frequency.value = 20000;
    lowpass.connect(master); master.connect(ctx.destination);
    ambBus = ctx.createGain(); sfxBus = ctx.createGain(); musBus = ctx.createGain();
    [ambBus, sfxBus, musBus].forEach((b) => b.connect(lowpass));
    ["music", "sfx", "amb"].forEach(applyBus);

    // eco per la musica
    echoIn = ctx.createGain();
    const delay = ctx.createDelay(1.5); delay.delayTime.value = 0.46;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const wet = ctx.createGain(); wet.gain.value = 0.5;
    echoIn.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(musBus);

    windFilter = loopNoise("bandpass", 420, 0.5);
    windGain = ctx.createGain(); windGain.gain.value = 0.02;
    windFilter.connect(windGain); windGain.connect(ambBus);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.12;
    const lfoG = ctx.createGain(); lfoG.gain.value = 180;
    lfo.connect(lfoG); lfoG.connect(windFilter.frequency); lfo.start();

    const wf = loopNoise("lowpass", 520, 0.4);
    waveGain = ctx.createGain(); waveGain.gain.value = 0;
    const swell = ctx.createGain(); swell.gain.value = 0.5;
    const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.13;
    const lfo2G = ctx.createGain(); lfo2G.gain.value = 0.5;
    lfo2.connect(lfo2G); lfo2G.connect(swell.gain); lfo2.start();
    wf.connect(swell); swell.connect(waveGain); waveGain.connect(ambBus);
  }

  function burst(dur, freq, vol, type = "lowpass", out = "sfx") {
    if (!ctx) return;
    const s = ctx.createBufferSource(); s.buffer = noiseBuffer(0.3);
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(bus(out)); s.start(t); s.stop(t + dur + 0.02);
  }
  function tone(f0, f1, dur, vol, type = "sine", delay = 0, out = "sfx", attack = 0.01, toEcho = false) {
    if (!ctx) return;
    const o = ctx.createOscillator(); o.type = type;
    const g = ctx.createGain(); const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t); if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus(out)); if (toEcho && echoIn) g.connect(echoIn);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // musica: pad lento su 4 accordi + note pentatoniche rade con eco
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const CHORDS = [[48, 55, 59, 64], [45, 52, 60, 64], [41, 48, 57, 64], [43, 50, 59, 62]];
  const SCALE = [72, 74, 76, 79, 81, 84];
  function musicTick(dt, day) {
    chordT -= dt;
    if (chordT <= 0) {
      chordT = 9;
      const ch = CHORDS[chordI++ % CHORDS.length];
      ch.forEach((m, i) => {
        tone(mtof(m), mtof(m), 11, 0.05, "triangle", i * 0.12, "music", 3);
        tone(mtof(m) * 1.003, mtof(m) * 1.003, 11, 0.025, "sine", i * 0.12, "music", 3);
      });
    }
    pluckT -= dt;
    if (pluckT <= 0) {
      pluckT = 1.6 + Math.random() * (day > 0.5 ? 3 : 5);
      const m = SCALE[Math.floor(Math.random() * SCALE.length)] - (day < 0.4 ? 12 : 0);
      tone(mtof(m), mtof(m), 2.2, 0.07, "triangle", 0, "music", 0.015, true);
    }
  }

  return {
    start,
    toggle(name) { on[name] = !on[name]; applyBus(name); return on[name]; },
    isOn(name) { return on[name]; },
    step(rough = 1) {
      burst(0.06, 600 + Math.random() * 300, 0.1 * rough);
      tone(110 + Math.random() * 20, 60, 0.07, 0.07 * rough, "sine");
    },
    jump() { burst(0.12, 900, 0.07, "bandpass"); tone(300, 520, 0.12, 0.04); },
    land(power = 1) { burst(0.14, 380, 0.16 * power); tone(90, 50, 0.14, 0.12 * power, "sine"); },
    click() { tone(660, 880, 0.07, 0.07, "triangle"); },
    enter() { tone(392, 523, 0.14, 0.08, "triangle"); tone(523, 659, 0.16, 0.07, "triangle", 0.1); },
    exit() { tone(523, 392, 0.14, 0.08, "triangle"); tone(392, 294, 0.16, 0.07, "triangle", 0.1); },
    greet() { tone(523, 784, 0.12, 0.08, "triangle"); tone(784, 1047, 0.18, 0.07, "triangle", 0.12); },
    chirp() {
      const base = 2200 + Math.random() * 1400;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) tone(base, base * (1.2 + Math.random() * 0.3), 0.07, 0.03, "sine", i * 0.11, "amb");
    },
    update(dt, seaNear, day, isIndoor) {
      if (!ctx) return;
      const t = ctx.currentTime;
      waveGain.gain.setTargetAtTime(isIndoor ? 0 : 0.006 + seaNear * seaNear * 0.05, t, 0.5);
      windGain.gain.setTargetAtTime(isIndoor ? 0.004 : 0.018 + (1 - seaNear) * 0.02, t, 0.5);
      if (isIndoor !== indoor) {
        indoor = isIndoor;
        lowpass.frequency.setTargetAtTime(isIndoor ? 2200 : 20000, t, 0.15);
      }
      birdT -= dt;
      if (birdT <= 0) {
        birdT = 3 + Math.random() * 6;
        if (day > 0.5 && !isIndoor && seaNear < 0.7 && on.amb) this.chirp();
      }
      if (on.music) musicTick(dt, day);
    },
  };
}
