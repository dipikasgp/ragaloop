# RagaLoop

Live-code Indian classical music in the browser — sitar, santoor, and tabla —
and loop it with zero gap between repetitions.

## Run

Any static server works:

```sh
cd ragaloop
python3 -m http.server 8420
open http://127.0.0.1:8420/
```

## The composer

The UI is a form: tempo and key (Sa) at the top, then one row per track —
instrument dropdown, pattern field, per-track `vol` (0–2) and `oct` (whole
octaves), and ＋ add track. Everything auto-saves as you type. Under the hood
each composition compiles to the DSL below, which the parser consumes;
`textToModel`/`buildSource` in `js/main.js` convert both ways, so old
text-format saves and the examples migrate automatically.

## The language (internal format)

```
bpm 100

tabla:   dha dhin dhin dha | dha tin tin ta
sitar:   Ni, Re Ga Ma+ | Pa ~ Ma+ Ga
santoor: [Sa Sa'] [Ga Sa'] - -
```

- One line per instrument: `tabla`, `sitar`, `santoor` (suffix a digit for a
  second track of the same instrument, e.g. `sitar2:`).
- `key C#` moves Sa to any pitch (default D). The recorded tabla is re-pitched
  by playback rate so its ringing strokes land exactly on the same Sa — the
  drum and the lehra always share one tonic, in every key. (The recorded
  dayan's measured fundamental, 284 Hz, is `tablaBaseHz` in `js/synth.js`.)
- Each top-level token is one beat. `|` bar lines are cosmetic. `#` comments.
- `-` rest, `~` hold the previous note one more beat.
- `[a b c]` subdivides a beat evenly; nestable.
- Tabla bols: `dha dhin na tin ta tun ge ke ka te ti ra ki kat`.
- Melody is sargam: `Sa Re Ga Ma Pa Dha Ni`; komal in lowercase (`re ga dha ni`),
  tivra `Ma+`, octave up `Sa'`, octave down `Sa,`. Sa is tuned to D.
- Tracks of different lengths loop independently (polymeter).

While playing, edit and press **Cmd/Ctrl+Enter** — the new pattern is swapped
in without stopping the transport, in phase with the running beat clock.

## Compositions

The header has a file picker: **＋ New** starts a composition from a starter
template, ✎ renames, 🗑 deletes. Everything auto-saves to the browser's
localStorage as you type. Loading an example opens it as its own file, so it
never overwrites your work.

## How the gapless looping works

`js/scheduler.js` implements the standard Web Audio lookahead pattern: a 25 ms
timer schedules every event in the next 120 ms window with sample-accurate
`source.start(time)` calls on a continuous beat timeline. Loop wrap-around is
plain arithmetic on that timeline, so repetition N+1 is scheduled before
repetition N has finished sounding — there is nothing to "restart".

## Sound

`js/synth.js` renders every note/stroke once into an `AudioBuffer` (cached):

- **Sitar / santoor** — Karplus-Strong plucked string; the sitar adds a
  time-decaying tanh drive to approximate the jawari buzz, the santoor plays
  two detuned strings per note with a hammer transient.
- **Tabla** — real recorded strokes in `samples/tabla/` (4 variants per bol,
  round-robined for natural variation). Bols map to sample families in
  `SynthEngine.TABLA_FAMILIES`; anything without a recording (currently `tun`)
  falls back to the built-in modal synthesis, as does the whole instrument if
  the samples fail to load.

The recordings come from the
[Tabla-Taal-and-Bol-Identification](https://github.com/TarangSingh03/Tabla-Taal-and-Bol-Identification)
dataset (no explicit license — fine for personal use; swap in your own
recordings before distributing). They were preprocessed: leading silence
trimmed to the onset, downmixed to mono, peak-normalized, edges faded. To use
your own samples, drop `<family>1.wav … <family>4.wav` files into
`samples/tabla/`.

- **Sitar** — per-note recordings in `samples/sitar/` (chromatic D2–A5),
  rendered with fluidsynth through the sitar preset of the soundfont from
  [dipikasgp/talkintunes](https://github.com/dipikasgp/talkintunes) — the same
  sound path that app used (`fluidsynth` + `default_sound_font.sf2`, GM
  program 104). Notes are peak-normalized on load; any missing note is covered
  by the nearest neighbour with playback-rate pitch shifting. Falls back to
  Karplus-Strong synthesis if loading fails. To re-render (e.g. a different
  range or velocity): generate one-note MIDIs for program 104 and run
  `fluidsynth -ni -F out.wav font.sf2 note.mid`.

- **Santoor** — per-note recordings in `samples/santoor/` (chromatic D3–A6),
  rendered the same way from the same soundfont's Dulcimer preset (GM program
  15 — a hammered dulcimer, structurally the same instrument as a santoor).
  Karplus-Strong fallback if loading fails.

The sitar bus has a gentle sweetening EQ (warmth low-shelf, small cut at the
pick-bite band, softened top) plus a slightly larger reverb send — see
`sitarSweet` in `js/synth.js` to taste.
