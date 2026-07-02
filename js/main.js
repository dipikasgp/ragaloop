/* UI wiring: form-based composer (one row per track), transport, files. */

const EXAMPLES = {
  'Teental groove': `# Teental — the classic 16-beat cycle
bpm 100

tabla: dha dhin dhin dha | dha dhin dhin dha | dha tin tin ta | ta dhin dhin dha
`,

  'Yaman trio': `bpm 84

tabla vol=1.1:   dha dhin dhin dha | dha dhin dhin dha | dha tin tin ta | ta dhin dhin dha
sitar vol=0.9:   Ni Re' Ga' Ma+' | Pa' ~ Ma+' Ga' | Re' Ga' Ma+' Dha' | Ni' ~ Sa'' -
santoor vol=0.6: - - Ga - | - - Ma+ - | Pa - - Dha | - Ni Dha Pa
`,

  'Bhimpalasi teental': `bpm 76

tabla vol=1.1:   dha dhin dhin dha | dha dhin dhin dha | dha tin tin ta | ta dhin dhin dha
sitar oct=1:     ni, Sa ga Ma | Pa ~ ni Sa' | ni Dha Pa Ma | ga Re Sa ~
santoor vol=0.5: - - ga - | - - Ma - | Pa - - ni | - Dha Pa Ma
`,

  'Malkauns teental': `bpm 70
key C#

tabla vol=1.1:   dha dhin dhin dha | dha dhin dhin dha | dha tin tin ta | ta dhin dhin dha
sitar oct=1:     Sa ~ ga Ma | dha ~ ni dha | Ma ga Ma dha | [ni dha] Ma ga Sa
santoor vol=0.5: - ga - Ma | - - dha - | ni - - dha | - Ma ga -
`,

  'Sitar taan (high)': `bpm 96

tabla vol=0.8: dha - tin - | na - dhin -
sitar oct=1: [Sa Re Ga Ma+] [Pa Ma+ Ga Re] [Ga Ma+ Pa Dha] [Ni Dha Pa Ma+] | Pa ~ [Ga Re] Sa | [Ni, Re Ga Ma+] [Pa Dha Ni Sa'] Sa' ~ | Ni ~ Pa -
`,

  'Keherwa + santoor': `bpm 112

tabla:   dha ge na tin | na ke dhin na
santoor vol=0.8: [Sa Sa'] [Ga Sa'] [Pa Sa'] [Ga Sa'] | [Ma Sa'] [Ga Sa'] [Re Sa'] [ni, Sa]
sitar vol=0.9:   Sa' ~ [Ni Sa'] Ga' | Pa' ~ [Ga' Re'] Sa'
`,

  'Tabla solo (tirakita)': `bpm 90

tabla vol=1.3: dha - [ti ra ki ta] dha | [dha ge] [ti ra ki ta] dhin - | na tin [na ka] dhin | [dha ti] [dha ge] tin ta
`,
};

const INSTRUMENT_NAMES = ['tabla', 'sitar', 'santoor'];
const KEY_CHOICES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
// map any accepted spelling to the canonical choice above
const KEY_CANON = {
  'c': 'C', 'c#': 'C#', 'db': 'C#', 'd': 'D', 'd#': 'Eb', 'eb': 'Eb', 'e': 'E',
  'f': 'F', 'f#': 'F#', 'gb': 'F#', 'g': 'G', 'g#': 'Ab', 'ab': 'Ab', 'a': 'A',
  'a#': 'Bb', 'bb': 'Bb', 'b': 'B',
};

// ---- composition model <-> DSL text ----

// Convert DSL text (examples, legacy saved files) into a structured model.
function textToModel(text) {
  const model = { bpm: 90, key: 'D', tracks: [] };
  const byName = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    let m;
    if ((m = /^bpm\s+(\d+(?:\.\d+)?)$/i.exec(line))) { model.bpm = parseFloat(m[1]); continue; }
    if ((m = /^key\s+(\S+)$/i.exec(line))) { model.key = KEY_CANON[m[1].toLowerCase()] || 'D'; continue; }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const hparts = line.slice(0, colon).trim().split(/\s+/);
    const name = hparts[0].toLowerCase();
    const inst = name.replace(/\d+$/, '');
    if (!INSTRUMENT_NAMES.includes(inst)) continue;
    const pattern = line.slice(colon + 1).trim();
    let track = byName[name];
    if (!track) {
      track = { inst, vol: 1, oct: 0, pattern: '' };
      byName[name] = track;
      model.tracks.push(track);
    }
    track.pattern = track.pattern ? `${track.pattern} | ${pattern}` : pattern;
    for (const p of hparts.slice(1)) {
      const mm = /^(vol|oct)=(-?\d+(?:\.\d+)?)$/i.exec(p);
      if (mm) track[mm[1].toLowerCase()] = parseFloat(mm[2]);
    }
  }
  return model;
}

// Assemble the model back into DSL text for the parser. Also returns which
// row produced each line, so parser errors can point at the right field.
function buildSource(model) {
  const lines = [`bpm ${model.bpm}`, `key ${model.key}`];
  const rowOfLine = [null, null];
  model.tracks.forEach((t, i) => {
    if (!t.pattern.trim()) return;
    let head = `${t.inst}${i + 1}`;
    if (t.vol !== 1) head += ` vol=${t.vol}`;
    if (t.oct) head += ` oct=${t.oct}`;
    lines.push(`${head}: ${t.pattern}`);
    rowOfLine.push(i);
  });
  return { text: lines.join('\n'), rowOfLine };
}

const NEW_FILE_MODEL = () => textToModel(`bpm 90
tabla: dha dhin dhin dha | dha dhin dhin dha | dha tin tin ta | ta dhin dhin dha
sitar oct=1: Sa - ga Ma | Pa - - -
`);

(function main() {
  const playBtn = document.getElementById('play');
  const stopBtn = document.getElementById('stop');
  const applyBtn = document.getElementById('apply');
  const statusEl = document.getElementById('status');
  const bpmEl = document.getElementById('bpm-readout');
  const beatEl = document.getElementById('beat-lamp');
  const exampleSel = document.getElementById('examples');
  const fileSel = document.getElementById('file-select');
  const bpmInput = document.getElementById('bpm-input');
  const keyInput = document.getElementById('key-input');
  const tracksEl = document.getElementById('tracks');

  for (const k of KEY_CHOICES) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    keyInput.appendChild(opt);
  }

  // ---- compositions, persisted in localStorage ----

  const store = {
    data: null,
    load() {
      try { this.data = JSON.parse(localStorage.getItem('ragaloop-files') || 'null'); } catch (e) { this.data = null; }
      if (!this.data || !this.data.files || !Object.keys(this.data.files).length) {
        const legacy = localStorage.getItem('ragaloop-src');
        this.data = {
          files: { 'my first loop': legacy ? textToModel(legacy) : textToModel(EXAMPLES['Yaman trio']) },
          current: 'my first loop',
        };
      }
      // migrate files saved as DSL text by older versions
      for (const [name, val] of Object.entries(this.data.files)) {
        if (typeof val === 'string') this.data.files[name] = textToModel(val);
      }
      if (!(this.data.current in this.data.files)) {
        this.data.current = Object.keys(this.data.files)[0];
      }
      this.save();
    },
    save() { localStorage.setItem('ragaloop-files', JSON.stringify(this.data)); },
    uniqueName(base) {
      let name = base, n = 2;
      while (name in this.data.files) name = `${base} ${n++}`;
      return name;
    },
  };

  let model = null;   // the currently open composition (reference into store)

  // ---- form rendering ----

  function renderForm() {
    bpmInput.value = model.bpm;
    keyInput.value = model.key;
    tracksEl.innerHTML = '';
    model.tracks.forEach((t, i) => tracksEl.appendChild(trackRow(t, i)));
  }

  function trackRow(track, index) {
    const row = document.createElement('div');
    row.className = 'track-row';

    const inst = document.createElement('select');
    inst.className = 't-inst';
    for (const name of INSTRUMENT_NAMES) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      opt.selected = name === track.inst;
      inst.appendChild(opt);
    }
    inst.addEventListener('change', () => { track.inst = inst.value; store.save(); });

    const pattern = document.createElement('input');
    pattern.className = 't-pattern';
    pattern.type = 'text';
    pattern.spellcheck = false;
    pattern.placeholder = track.inst === 'tabla' ? 'dha dhin dhin dha …' : "Sa Re Ga Ma …";
    pattern.value = track.pattern;
    pattern.addEventListener('input', () => { track.pattern = pattern.value; store.save(); });

    const vol = document.createElement('input');
    vol.className = 't-vol';
    vol.type = 'number';
    vol.min = 0; vol.max = 2; vol.step = 0.1;
    vol.value = track.vol;
    vol.addEventListener('input', () => { track.vol = parseFloat(vol.value) || 0; store.save(); });

    const oct = document.createElement('input');
    oct.className = 't-oct';
    oct.type = 'number';
    oct.min = -2; oct.max = 2; oct.step = 1;
    oct.value = track.oct;
    oct.addEventListener('input', () => { track.oct = parseInt(oct.value, 10) || 0; store.save(); });

    const del = document.createElement('button');
    del.className = 't-del';
    del.title = 'Remove track';
    del.textContent = '×';
    del.addEventListener('click', () => {
      model.tracks.splice(index, 1);
      store.save();
      renderForm();
    });

    row.append(inst, pattern, vol, oct, del);
    return row;
  }

  bpmInput.addEventListener('input', () => {
    model.bpm = Math.min(300, Math.max(20, parseFloat(bpmInput.value) || 90));
    store.save();
  });
  keyInput.addEventListener('change', () => {
    model.key = keyInput.value;
    store.save();
    if (scheduler && scheduler.playing) apply();   // key changes feel immediate
  });

  document.getElementById('add-track').addEventListener('click', () => {
    model.tracks.push({ inst: 'sitar', vol: 1, oct: 1, pattern: '' });
    store.save();
    renderForm();
    const inputs = tracksEl.querySelectorAll('.t-pattern');
    inputs[inputs.length - 1].focus();
  });

  // ---- files ----

  function refreshFileList() {
    fileSel.innerHTML = '';
    for (const name of Object.keys(store.data.files)) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      opt.selected = name === store.data.current;
      fileSel.appendChild(opt);
    }
  }

  function openFile(name) {
    store.data.current = name;
    model = store.data.files[name];
    store.save();
    refreshFileList();
    renderForm();
  }

  store.load();
  model = store.data.files[store.data.current];
  refreshFileList();
  renderForm();

  fileSel.addEventListener('change', () => openFile(fileSel.value));

  document.getElementById('new-file').addEventListener('click', () => {
    const name = prompt('Name for the new composition:', store.uniqueName('untitled'));
    if (!name) return;
    const unique = name in store.data.files ? store.uniqueName(name) : name;
    store.data.files[unique] = NEW_FILE_MODEL();
    openFile(unique);
    setStatus(`created "${unique}" — write your loop and press Play`);
  });

  document.getElementById('rename-file').addEventListener('click', () => {
    const oldName = store.data.current;
    const name = prompt('Rename composition:', oldName);
    if (!name || name === oldName) return;
    const unique = name in store.data.files ? store.uniqueName(name) : name;
    store.data.files[unique] = store.data.files[oldName];
    delete store.data.files[oldName];
    openFile(unique);
  });

  document.getElementById('delete-file').addEventListener('click', () => {
    const name = store.data.current;
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    delete store.data.files[name];
    if (!Object.keys(store.data.files).length) {
      store.data.files[store.uniqueName('untitled')] = NEW_FILE_MODEL();
    }
    openFile(Object.keys(store.data.files)[0]);
    setStatus(`deleted "${name}"`);
  });

  // Examples open as their own file so they never overwrite your work.
  for (const name of Object.keys(EXAMPLES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    exampleSel.appendChild(opt);
  }
  exampleSel.addEventListener('change', () => {
    const name = exampleSel.value;
    if (!name) return;
    exampleSel.value = '';
    if (name in store.data.files) {
      openFile(name);
    } else {
      store.data.files[name] = textToModel(EXAMPLES[name]);
      openFile(name);
    }
    if (scheduler && scheduler.playing) apply();
  });

  // ---- audio ----

  let ctx = null, engine = null, scheduler = null, samplesReady = null;

  function ensureAudio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      engine = new SynthEngine(ctx);
      samplesReady = Promise.all([
        engine.loadTablaSamples(),
        engine.loadPitchedSamples('sitar', 'samples/sitar/'),
        engine.loadPitchedSamples('santoor', 'samples/santoor/', 'm4a', 50, 93),
      ]).then(([tabla, sitar, santoor]) => {
        const missing = [!tabla && 'tabla', !sitar && 'sitar', !santoor && 'santoor'].filter(Boolean);
        if (missing.length) setStatus(`note: ${missing.join(', ')} samples not found — using synth fallback`, false);
      });
      scheduler = new Scheduler(ctx, engine);
      scheduler.onBeat = beat => {
        beatEl.textContent = String(beat % 16 + 1);
        beatEl.classList.remove('pulse');
        void beatEl.offsetWidth;          // restart the CSS animation
        beatEl.classList.add('pulse');
      };
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
  }

  function compile() {
    store.save();
    const { text, rowOfLine } = buildSource(model);
    const parsed = RagaParser.parse(text);
    for (const row of tracksEl.querySelectorAll('.track-row')) row.classList.remove('bad');
    if (parsed.errors.length) {
      const pretty = parsed.errors.map(e => {
        const m = /^line (\d+): (.*)$/.exec(e);
        if (!m) return e;
        const rowIdx = rowOfLine[parseInt(m[1], 10) - 1];
        if (rowIdx === null || rowIdx === undefined) return m[2];
        tracksEl.children[rowIdx] && tracksEl.children[rowIdx].classList.add('bad');
        return `${model.tracks[rowIdx].inst} track ${rowIdx + 1}: ${m[2].replace(/"([^"]*)" is not/, '"$1" is not')}`;
      });
      setStatus(pretty.join('   •   '), true);
      return null;
    }
    return parsed;
  }

  async function play() {
    ensureAudio();
    const parsed = compile();
    if (!parsed) return;
    setStatus('loading samples…');
    await samplesReady;
    scheduler.play(parsed);
    bpmEl.textContent = `${parsed.bpm} bpm · Sa=${parsed.keyName}`;
    setStatus(`playing — ${parsed.tracks.length} track${parsed.tracks.length === 1 ? '' : 's'} looping`);
    document.body.classList.add('playing');
  }

  function apply() {
    const parsed = compile();
    if (!parsed) return;
    if (scheduler && scheduler.playing) {
      scheduler.update(parsed);
      bpmEl.textContent = `${parsed.bpm} bpm · Sa=${parsed.keyName}`;
      setStatus('updated live — new pattern picked up in place');
    } else {
      play();
    }
  }

  function stop() {
    if (scheduler) scheduler.stop();
    setStatus('stopped');
    document.body.classList.remove('playing');
    beatEl.textContent = '·';
  }

  playBtn.addEventListener('click', play);
  stopBtn.addEventListener('click', stop);
  applyBtn.addEventListener('click', apply);

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      apply();
    }
  });

  setStatus('ready — press Play, or Cmd/Ctrl+Enter to apply changes while looping');
})();
