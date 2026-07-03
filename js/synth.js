/* RagaLoop synthesis engine.
 *
 * Every sound is rendered once into an AudioBuffer (cached), then triggered
 * with sample-accurate AudioBufferSourceNode.start(time). Rendering offline
 * keeps playback jitter-free and makes swapping in real recorded samples
 * later trivial: replace the render* functions with sample loading.
 *
 * Sitar & santoor: Karplus-Strong plucked/struck string.
 * Tabla: additive modal synthesis (pitch-swept sines + filtered noise).
 * Everything is tuned to Sa = D.
 */

class SynthEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.cache = new Map();

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 4;
    this.master.connect(this.comp).connect(ctx.destination);

    // Shared room reverb (synthetic impulse response — no assets needed).
    // Dry samples are a big part of why triggered notes sound mechanical.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulseResponse(2.8, 2.3);
    this.reverb.connect(this.master);

    this.buses = {};
    const mk = (gain, pan, wet, inserts = []) => {
      const g = ctx.createGain();
      g.gain.value = gain;
      let tail = g;
      for (const f of inserts) { tail.connect(f); tail = f; }
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      tail.connect(p).connect(this.master);
      const send = ctx.createGain();
      send.gain.value = wet;
      tail.connect(send).connect(this.reverb);
      return g;
    };

    // Gentle sweetening on the sitar: a little warmth, a little less pick
    // bite, a touch more room. Subtle on purpose — the source sound is good.
    const eq = (type, frequency, gain, Q = 1) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.gain.value = gain;
      f.Q.value = Q;
      return f;
    };
    const sitarSweet = [
      eq('lowshelf', 300, 4),          // warmth
      eq('peaking', 800, 2, 0.8),      // roundness / body
      eq('peaking', 3200, -5.5, 1),    // pick/jawari bite
      eq('highshelf', 9000, -4),       // soften the very top
    ];

    this.buses.tabla = mk(1.0, 0, 0.12);
    this.buses.sitar = mk(0.85, -0.25, 0.5, sitarSweet);
    this.buses.santoor = mk(0.6, 0.25, 0.3);
    this.buses.sarod = mk(0.8, -0.35, 0.25);
    this.buses.harmonium = mk(0.5, 0.1, 0.2);
    this.buses.esraj = mk(0.6, 0.35, 0.35);
    this.buses.sarangi = mk(0.65, -0.1, 0.35);
    this.buses.bansuri = mk(0.6, 0.15, 0.3);
    this.buses.tanpura = mk(0.4, 0, 0.3);

    // Sa = D for everything; each instrument sits in its natural register.
    this.tonic = {
      sitar: 146.83, santoor: 293.66, tabla: 293.66, sarod: 146.83,
      harmonium: 293.66, esraj: 293.66, sarangi: 293.66, bansuri: 293.66,
      tanpura: 146.83,
    };

    // The `key` directive transposes Sa (semitones relative to D).
    this.keyOffset = 0;
    // Measured ringing pitch of the recorded dayan (tin fundamental). The
    // drum is re-pitched by playback rate so it always rings exactly on Sa —
    // a real tabla and lehra must share one tonic.
    this.tablaBaseHz = 284;

    this.samples = {};        // bol -> [AudioBuffer, …] (recorded tabla strokes)
    this.sampleCounter = {};  // bol -> round-robin index
    this.pitched = {};        // inst -> Map(midi -> AudioBuffer) (recorded notes)
    this.saMidi = {
      sitar: 50, santoor: 62, sarod: 50, harmonium: 62,
      esraj: 62, sarangi: 62, bansuri: 62, tanpura: 50,
    };
  }

  static NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  // Bowed/blown/reed voices sustain for the note's written length, then
  // release; plucked voices just ring out their natural decay.
  static SUSTAINED = new Set(['harmonium', 'esraj', 'sarangi', 'bansuri']);

  // Recorded tabla strokes. Each bol maps to a sample family on disk
  // (samples/tabla/<family>N.wav, 4 variants each, round-robined so
  // repeated strokes don't sound machine-gun identical).
  static TABLA_FAMILIES = {
    dha: 'dha', dhin: 'dhin', dhi: 'dhin',
    ge: 'ga', ghe: 'ga',
    ke: 'ka', ka: 'ka', kat: 'ka',
    ta: 'ta', na: 'ta',
    tin: 'tin',
    te: 't', ti: 't',
    ra: 'tit', ki: 'tit', tit: 'tit',
    // no recording for: tun — synth fallback
  };

  async loadTablaSamples(baseUrl = 'samples/tabla/') {
    const families = [...new Set(Object.values(SynthEngine.TABLA_FAMILIES))];
    await Promise.all(families.map(async fam => {
      const bufs = [];
      for (let n = 1; n <= 4; n++) {
        try {
          const res = await fetch(`${baseUrl}${fam}${n}.wav`);
          if (!res.ok) break;
          bufs.push(await this.ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (e) {
          break; // missing/undecodable variant — use what we have
        }
      }
      if (bufs.length) this.samples[fam] = bufs;
    }));
    return Object.keys(this.samples).length > 0;
  }

  // Per-note recordings (samples/<inst>/<Note><Octave>.mp3, chromatic).
  // Buffers are peak-normalized on load — some soundfont renders are -28 dB.
  async loadPitchedSamples(inst, baseUrl, ext = 'm4a', fromMidi = 38, toMidi = 81) {
    const notes = new Map();
    await Promise.all(Array.from({ length: toMidi - fromMidi + 1 }, async (_, k) => {
      const midi = fromMidi + k;
      const name = SynthEngine.NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
      try {
        const res = await fetch(`${baseUrl}${name}.${ext}`);
        if (!res.ok) return;
        const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
        let peak = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        }
        if (peak > 0) {
          const g = 0.6 / peak;
          for (let c = 0; c < buf.numberOfChannels; c++) {
            const d = buf.getChannelData(c);
            for (let i = 0; i < d.length; i++) d[i] *= g;
          }
        }
        notes.set(midi, buf);
      } catch (e) { /* missing note — nearest neighbour covers it */ }
    }));
    if (notes.size) this.pitched[inst] = notes;
    return notes.size > 0;
  }

  trigger(inst, event, time, durSec = 0.5, vol = 1) {
    // Humanize: no player lands exactly on the grid at exactly the same
    // strength twice. Slight late-only jitter, accented downbeats, ±cents.
    const jitter = Math.random() * (inst === 'tabla' ? 0.003 : 0.007);
    const onBeat = Math.abs(event.beat - Math.round(event.beat)) < 1e-6;
    // Melodic lines get much flatter dynamics than the tabla — even note
    // strength is what makes runs feel flowing rather than bouncy.
    const offBeat = inst === 'tabla' ? 0.8 : 0.93;
    const accent = vol * (onBeat ? 1.0 : offBeat) * (0.9 + Math.random() * 0.1);
    const detune = inst === 'tabla' ? 1 : Math.pow(2, (Math.random() * 10 - 5) / 1200);
    time += jitter;

    const keyRate = Math.pow(2, this.keyOffset / 12);

    if (inst !== 'tabla' && this.pitched[inst]) {
      const notes = this.pitched[inst];
      const midi = this.saMidi[inst] + this.keyOffset + event.semi;
      let best = null;
      for (const m of notes.keys()) {
        if (best === null || Math.abs(m - midi) < Math.abs(best - midi)) best = m;
      }
      const rate = Math.pow(2, (midi - best) / 12) * detune;
      const glideRate = event.semiTo !== undefined
        ? Math.pow(2, (this.saMidi[inst] + this.keyOffset + event.semiTo - best) / 12) * detune
        : null;
      // Sitar: shave the pick transient with a 20 ms swell — legato feel.
      // Sustained voices get a gentler bow/breath onset and a timed release.
      const sustained = SynthEngine.SUSTAINED.has(inst);
      const softAttack = inst === 'sitar' ? 0.02 : sustained ? 0.04 : 0;
      const holdSec = sustained ? durSec : 0;
      this._play(notes.get(best), inst, time, rate, accent, glideRate, durSec, softAttack, holdSec);
      return;
    }
    if (inst === 'tabla') {
      const fam = SynthEngine.TABLA_FAMILIES[event.token];
      const variants = fam && this.samples[fam];
      if (variants) {
        const i = (this.sampleCounter[fam] = ((this.sampleCounter[fam] || 0) + 1) % variants.length);
        // re-tune the recorded drum onto Sa in the current key
        const tablaRate = (this.tonic.tabla / this.tablaBaseHz) * keyRate;
        this._play(variants[i], 'tabla', time, tablaRate, accent);
        return;
      }
    }
    const key = inst === 'tabla' ? `tabla:${event.token}` : `${inst}:${event.semi}`;
    let buf = this.cache.get(key);
    if (!buf) {
      buf = inst === 'tabla'
        ? this.renderTabla(event.token)
        : this.renderString(inst, this.tonic[inst] * Math.pow(2, event.semi / 12));
      this.cache.set(key, buf);
    }
    // synth voices are rendered in D, so the key transposes them by rate
    this._play(buf, inst, time, detune * keyRate, accent);
  }

  _play(buffer, inst, time, rate = 1, gain = 1, glideRate = null, durSec = 0.5, softAttack = 0, holdSec = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    if (glideRate !== null) {
      // meend: hold the starting pitch briefly, then slide across the note
      src.playbackRate.setValueAtTime(rate, time + durSec * 0.25);
      src.playbackRate.linearRampToValueAtTime(glideRate, time + durSec * 0.95);
    }
    const g = this.ctx.createGain();
    if (softAttack > 0) {
      g.gain.setValueAtTime(gain * 0.3, time);
      g.gain.linearRampToValueAtTime(gain, time + softAttack);
    } else {
      g.gain.value = gain;
    }
    if (holdSec > 0) {
      // sustained voice: hold for the written note length, then release
      const release = 0.12;
      g.gain.setValueAtTime(gain, time + holdSec);
      g.gain.linearRampToValueAtTime(0.0001, time + holdSec + release);
      src.stop(time + holdSec + release + 0.05);
    }
    src.connect(g).connect(this.buses[inst]);
    src.start(time);
  }

  // Stereo impulse response: exponentially decaying noise = small hall.
  // The noise is lowpassed so the tail is dark and warm, not hissy.
  _impulseResponse(dur, decay) {
    const len = Math.ceil(dur * this.sr);
    const buf = this.ctx.createBuffer(2, len, this.sr);
    const a = Math.exp((-2 * Math.PI * 3200) / this.sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp = (1 - a) * (Math.random() * 2 - 1) + a * lp;
        d[i] = lp * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // ---------- shared helpers ----------

  _buffer(data) {
    const buf = this.ctx.createBuffer(1, data.length, this.sr);
    buf.copyToChannel(data, 0);
    return buf;
  }

  _normalize(data, target = 0.85) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak > 0) for (let i = 0; i < data.length; i++) data[i] *= target / peak;
    // short fade-out so loops never click
    const fade = Math.min(data.length, Math.round(this.sr * 0.01));
    for (let i = 0; i < fade; i++) data[data.length - 1 - i] *= i / fade;
    return data;
  }

  // Sine partial with exponential pitch sweep and exponential amplitude decay.
  _addSine(data, { f0, f1 = f0, sweep = 0.04, amp = 1, decay = 0.3, delay = 0 }) {
    const sr = this.sr;
    let phase = 0;
    const start = Math.round(delay * sr);
    for (let i = start; i < data.length; i++) {
      const t = (i - start) / sr;
      const f = f1 + (f0 - f1) * Math.exp(-t / sweep);
      phase += (2 * Math.PI * f) / sr;
      data[i] += amp * Math.exp(-t / decay) * Math.sin(phase);
    }
  }

  // Filtered noise burst (one-pole lowpass + one-pole highpass).
  _addNoise(data, { amp = 1, decay = 0.05, lp = 5000, hp = 200 }) {
    const sr = this.sr;
    const aLp = Math.exp((-2 * Math.PI * lp) / sr);
    const aHp = Math.exp((-2 * Math.PI * hp) / sr);
    let lpState = 0, hpState = 0;
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      const n = (Math.random() * 2 - 1) * amp * Math.exp(-t / decay);
      lpState = (1 - aLp) * n + aLp * lpState;
      hpState = (1 - aHp) * lpState + aHp * hpState;
      data[i] += lpState - hpState;
    }
  }

  // ---------- tabla ----------

  renderTabla(bol) {
    const f = this.tonic.tabla;                     // dayan tuned to Sa
    const dur = { tun: 1.0, tin: 0.6, dhin: 0.6, ge: 0.5, ghe: 0.5, dha: 0.5 }[bol] || 0.25;
    const data = new Float32Array(Math.ceil(dur * this.sr));

    const bayan = () => {                            // resonant bass drum
      this._addSine(data, { f0: 165, f1: 72, sweep: 0.06, amp: 1.0, decay: 0.22 });
      this._addNoise(data, { amp: 0.5, decay: 0.015, lp: 900, hp: 60 });
    };
    const na = (tight) => {                          // ringing rim stroke
      this._addSine(data, { f0: f * 1.89, amp: 0.7, decay: tight ? 0.07 : 0.11 });
      this._addSine(data, { f0: f * 2.94, amp: 0.45, decay: tight ? 0.05 : 0.08 });
      this._addSine(data, { f0: f * 4.2, amp: 0.2, decay: 0.03 });
      this._addNoise(data, { amp: 0.6, decay: 0.006, lp: 7000, hp: 1200 });
    };
    const tin = () => {                              // open ringing tone
      this._addSine(data, { f0: f * 2.0, amp: 0.8, decay: 0.35 });
      this._addSine(data, { f0: f * 3.05, amp: 0.25, decay: 0.12 });
      this._addNoise(data, { amp: 0.3, decay: 0.005, lp: 6000, hp: 1000 });
    };

    switch (bol) {
      case 'ge': case 'ghe': bayan(); break;
      case 'na': na(false); break;
      case 'ta': na(true); break;
      case 'tin': tin(); break;
      case 'tun':
        this._addSine(data, { f0: f * 1.02, f1: f, sweep: 0.15, amp: 1.0, decay: 0.55 });
        this._addSine(data, { f0: f * 2.01, amp: 0.3, decay: 0.2 });
        this._addNoise(data, { amp: 0.25, decay: 0.006, lp: 5000, hp: 800 });
        break;
      case 'ke': case 'ka': case 'kat':
        this._addNoise(data, { amp: 1.0, decay: 0.025, lp: 3500, hp: 350 });
        break;
      case 'te': case 'ti': case 'ra': case 'ki': case 'tit':
        this._addNoise(data, { amp: 0.8, decay: 0.02, lp: 2500, hp: 500 });
        this._addSine(data, { f0: f * 1.4, amp: 0.35, decay: 0.04 });
        break;
      case 'dha': bayan(); na(false); break;         // dha = ge + na
      case 'dhin': case 'dhi': bayan(); tin(); break; // dhin = ge + tin
      default: na(true);
    }
    return this._buffer(this._normalize(data));
  }

  // ---------- sitar & santoor (Karplus-Strong) ----------

  _karplusStrong(freq, dur, { damping, pluckSoft = 0 }) {
    const sr = this.sr;
    const N = Math.max(2, Math.round(sr / freq));
    const delay = new Float32Array(N);
    // Excite with noise; pluckSoft lowpasses the burst for a mellower attack.
    let s = 0;
    for (let i = 0; i < N; i++) {
      const n = Math.random() * 2 - 1;
      s = pluckSoft * s + (1 - pluckSoft) * n;
      delay[i] = s;
    }
    const out = new Float32Array(Math.ceil(dur * sr));
    let idx = 0, prev = 0;
    for (let i = 0; i < out.length; i++) {
      const cur = delay[idx];
      out[i] = cur;
      delay[idx] = damping * 0.5 * (cur + prev);
      prev = cur;
      idx = (idx + 1) % N;
    }
    return out;
  }

  renderString(inst, freq) {
    const sr = this.sr;
    if (inst === 'sitar') {
      const dur = 2.8;
      // Normalize decay across pitch: higher notes need damping closer to 1.
      const damping = Math.min(0.9995, 0.994 + freq / 40000);
      const a = this._karplusStrong(freq, dur, { damping, pluckSoft: 0.1 });
      const b = this._karplusStrong(freq * 2.005, dur, { damping: damping - 0.002, pluckSoft: 0.2 });
      const data = new Float32Array(a.length);
      for (let i = 0; i < data.length; i++) {
        const t = i / sr;
        // Jawari buzz: drive through tanh, strongest right after the pluck.
        const drive = 1 + 3.5 * Math.exp(-t / 0.35);
        const x = a[i] + 0.3 * b[i];
        data[i] = (Math.tanh(x * drive) / drive) * Math.exp(-t / 1.4);
      }
      return this._buffer(this._normalize(data, 0.8));
    }
    // Santoor: two hammered strings per note, slightly detuned, bright & quick.
    const dur = 2.0;
    const damping = Math.min(0.9993, 0.9955 + freq / 60000);
    const a = this._karplusStrong(freq * 0.9985, dur, { damping, pluckSoft: 0 });
    const b = this._karplusStrong(freq * 1.0015, dur, { damping, pluckSoft: 0 });
    const data = new Float32Array(a.length);
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      data[i] = 0.5 * (a[i] + b[i]) * Math.exp(-t / 0.9);
    }
    // Hammer strike transient
    this._addNoise(data, { amp: 0.15, decay: 0.004, lp: 8000, hp: 2000 });
    return this._buffer(this._normalize(data, 0.75));
  }
}
