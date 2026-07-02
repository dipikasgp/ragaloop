/* RagaLoop pattern-language parser.
 *
 * Syntax:
 *   bpm 90                          — global tempo directive
 *   tabla:   dha dhin dhin dha | …  — one track per line, `|` bar separators are cosmetic
 *   sitar:   Sa Re Ga Ma Pa - Ga Re
 *   santoor: Sa' Ni Dha Pa
 *
 * Tokens (each top-level token = one beat):
 *   -            rest
 *   ~            extend the previous note/stroke by one beat
 *   [dha ge]     subdivide one beat evenly (nestable)
 *   # …          comment
 *
 * Melodic notes are sargam: Sa Re Ga Ma Pa Dha Ni.
 *   lowercase re/ga/dha/ni = komal (flat), Ma+ = tivra (sharp)
 *   trailing '  = octave up,  trailing ,  = octave down (repeatable)
 */

const RagaParser = (() => {
  const TABLA_BOLS = new Set([
    'dha', 'dhin', 'dhi', 'ta', 'na', 'tin', 'tun', 'ge', 'ghe',
    'ke', 'ka', 'kat', 'te', 'ti', 'ra', 'ki', 'tit',
  ]);

  const MELODIC = new Set(['sitar', 'santoor']);
  const INSTRUMENTS = new Set(['tabla', ...MELODIC]);

  const SARGAM_BASE = { sa: 0, re: 2, ga: 4, ma: 5, pa: 7, dha: 9, ni: 11 };
  const KOMAL_OK = new Set(['re', 'ga', 'dha', 'ni']);

  // Returns semitones relative to Sa, or null if not a valid sargam token.
  function parseSargam(token) {
    const m = /^(sa|re|ga|ma|pa|dha|ni)(\+?)('*|,*)$/i.exec(token);
    if (!m) return null;
    const name = m[1].toLowerCase();
    let semi = SARGAM_BASE[name];
    const isLower = token[0] === token[0].toLowerCase();
    if (isLower && KOMAL_OK.has(name)) semi -= 1;        // komal
    if (m[2] === '+') {
      if (name !== 'ma') return null;                     // tivra only exists for Ma
      semi += 1;
    }
    if (m[3].startsWith("'")) semi += 12 * m[3].length;
    if (m[3].startsWith(',')) semi -= 12 * m[3].length;
    return semi;
  }

  // Split a pattern into tokens, treating [ and ] as their own tokens.
  function tokenize(src) {
    return src
      .replace(/\|/g, ' ')
      .replace(/\[/g, ' [ ')
      .replace(/\]/g, ' ] ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  // Parse a token stream into a tree of items: strings or arrays (subdivisions).
  function parseGroups(tokens, lineNo, errors) {
    const stack = [[]];
    for (const tok of tokens) {
      if (tok === '[') {
        const group = [];
        stack[stack.length - 1].push(group);
        stack.push(group);
      } else if (tok === ']') {
        if (stack.length === 1) {
          errors.push(`line ${lineNo}: unmatched "]"`);
          return null;
        }
        stack.pop();
      } else {
        stack[stack.length - 1].push(tok);
      }
    }
    if (stack.length !== 1) {
      errors.push(`line ${lineNo}: unmatched "["`);
      return null;
    }
    return stack[0];
  }

  // Walk the item tree, emitting events. Each item at a level splits its
  // parent's duration evenly; top-level items are one beat each.
  function layout(items, startBeat, itemDur, inst, out, state, lineNo, errors) {
    let beat = startBeat;
    for (const item of items) {
      if (Array.isArray(item)) {
        if (item.length > 0) {
          layout(item, beat, itemDur / item.length, inst, out, state, lineNo, errors);
        }
      } else if (item === '-') {
        state.last = null;
      } else if (item === '~') {
        if (state.last) state.last.dur += itemDur;
      } else if (inst === 'tabla') {
        const bol = item.toLowerCase();
        if (!TABLA_BOLS.has(bol)) {
          errors.push(`line ${lineNo}: unknown tabla bol "${item}"`);
        } else {
          const ev = { beat, dur: itemDur, token: bol };
          out.push(ev);
          state.last = ev;
        }
      } else {
        // meend (glide): Ga'>Re' slides from the first note to the second
        const parts = item.split('>');
        const semi = parseSargam(parts[0]);
        const semiTo = parts.length === 2 ? parseSargam(parts[1]) : undefined;
        if (semi === null || parts.length > 2 || (parts.length === 2 && semiTo === null)) {
          errors.push(`line ${lineNo}: "${item}" is not a sargam note (Sa Re Ga Ma Pa Dha Ni, komal in lowercase, Ma+ for tivra, ' and , for octaves, Ga>Re for meend)`);
        } else {
          const ev = { beat, dur: itemDur, token: item, semi };
          if (semiTo !== undefined) ev.semiTo = semiTo;
          out.push(ev);
          state.last = ev;
        }
      }
      beat += itemDur;
    }
  }

  // Pitch classes for the `key` directive (Sa's concert pitch).
  const KEY_NAMES = {
    'c': 0, 'c#': 1, 'db': 1, 'd': 2, 'd#': 3, 'eb': 3, 'e': 4, 'f': 5,
    'f#': 6, 'gb': 6, 'g': 7, 'g#': 8, 'ab': 8, 'a': 9, 'a#': 10, 'bb': 10, 'b': 11,
  };

  function parse(source) {
    const errors = [];
    const tracks = [];
    let bpm = 90;
    let key = 0;              // semitones relative to D (the samples' home key)
    let keyName = 'D';

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      // a comment '#' must start the line or follow whitespace, so C# / F# survive
      const line = lines[i].replace(/(^|\s)#.*$/, '').trim();
      if (!line) continue;

      const bpmMatch = /^bpm\s+(\d+(?:\.\d+)?)$/i.exec(line);
      if (bpmMatch) {
        bpm = Math.min(300, Math.max(20, parseFloat(bpmMatch[1])));
        continue;
      }

      const keyMatch = /^key\s+(\S+)$/i.exec(line);
      if (keyMatch) {
        const pc = KEY_NAMES[keyMatch[1].toLowerCase()];
        if (pc === undefined) {
          errors.push(`line ${lineNo}: unknown key "${keyMatch[1]}" (use C, C#, Db, D … B)`);
        } else {
          // pick the transposition closest to the home key D
          key = ((pc - 2 + 6) % 12 + 12) % 12 - 6;
          keyName = keyMatch[1].charAt(0).toUpperCase() + keyMatch[1].slice(1);
        }
        continue;
      }

      const colon = line.indexOf(':');
      if (colon === -1) {
        errors.push(`line ${lineNo}: expected "instrument: pattern", "bpm <number>", or "key <note>"`);
        continue;
      }
      // Header: instrument name plus optional modifiers, e.g.
      //   sitar vol=0.6 oct=1:
      const hparts = line.slice(0, colon).trim().split(/\s+/);
      const name = hparts[0].toLowerCase();
      const inst = name.replace(/\d+$/, '');           // allow sitar2:, tabla2: …
      if (!INSTRUMENTS.has(inst)) {
        errors.push(`line ${lineNo}: unknown instrument "${name}" (use tabla, sitar, or santoor)`);
        continue;
      }
      let vol = null, oct = null, badMod = false;
      for (const p of hparts.slice(1)) {
        const m = /^(vol|oct)=(-?\d+(?:\.\d+)?)$/i.exec(p);
        if (!m) {
          errors.push(`line ${lineNo}: unknown modifier "${p}" (use vol=0.5 or oct=1)`);
          badMod = true;
        } else if (m[1].toLowerCase() === 'vol') {
          vol = Math.min(2, Math.max(0, parseFloat(m[2])));
        } else {
          oct = Math.round(parseFloat(m[2]));
          if (inst === 'tabla') {
            errors.push(`line ${lineNo}: oct= only applies to melodic instruments`);
            badMod = true;
          }
        }
      }
      if (badMod) continue;

      const tokens = tokenize(line.slice(colon + 1));
      if (tokens.length === 0) continue;
      const items = parseGroups(tokens, lineNo, errors);
      if (!items) continue;

      // A track may continue an earlier line with the same name.
      let track = tracks.find(t => t.name === name);
      if (!track) {
        track = { name, inst, events: [], length: 0, vol: 1 };
        tracks.push(track);
      }
      if (vol !== null) track.vol = vol;
      const state = { last: track.events[track.events.length - 1] || null };
      const firstNew = track.events.length;
      layout(items, track.length, 1, inst, track.events, state, lineNo, errors);
      track.length += items.length;
      if (oct) {
        for (let k = firstNew; k < track.events.length; k++) {
          const e = track.events[k];
          if (e.semi !== undefined) e.semi += 12 * oct;
          if (e.semiTo !== undefined) e.semiTo += 12 * oct;
        }
      }
    }

    for (const t of tracks) t.events.sort((a, b) => a.beat - b.beat);

    if (tracks.length === 0 && errors.length === 0) {
      errors.push('nothing to play — add a line like:  tabla: dha dhin dhin dha');
    }
    return { bpm, key, keyName, tracks: tracks.filter(t => t.events.length > 0 && t.length > 0), errors };
  }

  return { parse, parseSargam, TABLA_BOLS };
})();

if (typeof module !== 'undefined') module.exports = RagaParser;
