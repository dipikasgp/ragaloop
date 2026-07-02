/* Lookahead scheduler — the standard Web Audio pattern for gapless timing.
 *
 * A coarse setInterval timer wakes every 25 ms and schedules, with
 * sample-accurate start times, every event that falls inside the next
 * 120 ms window. Loop boundaries are just arithmetic on a beat timeline,
 * so there is zero delay between repetitions. Each track loops at its own
 * length (polymeter: a 16-beat theka against an 8-beat melody stays in
 * phase every 16 beats).
 *
 * Patterns can be hot-swapped while playing: the beat clock keeps running
 * and new tracks pick up mid-cycle at the current position.
 */

class Scheduler {
  constructor(ctx, engine) {
    this.ctx = ctx;
    this.engine = engine;
    this.lookahead = 0.12;      // seconds scheduled ahead
    this.interval = 25;         // ms between timer ticks
    this.playing = false;
    this.timer = null;
    this.onBeat = null;         // UI callback(beatNumber)
  }

  play(model) {
    this.stop();
    this.engine.keyOffset = model.key || 0;
    this.bpm = model.bpm;
    this.beatDur = 60 / model.bpm;
    this.startTime = this.ctx.currentTime + 0.1;
    this._setTracks(model.tracks, 0);
    this.lastUiBeat = -1;
    this.playing = true;
    this.timer = setInterval(() => this._tick(), this.interval);
    this._tick();
  }

  // Swap patterns without stopping. BPM changes restart the transport.
  update(model) {
    if (!this.playing) return false;
    this.engine.keyOffset = model.key || 0;   // key changes apply live
    if (model.bpm !== this.bpm) {
      this.play(model);
      return true;
    }
    const nowBeat = (this.ctx.currentTime - this.startTime) / this.beatDur;
    this._setTracks(model.tracks, Math.max(0, nowBeat));
    return true;
  }

  stop() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tracks = [];
  }

  _setTracks(tracks, fromBeat) {
    this.tracks = tracks.map(t => {
      const cycle = Math.floor(fromBeat / t.length);
      const inCycle = fromBeat - cycle * t.length;
      let i = t.events.findIndex(e => e.beat >= inCycle);
      let c = cycle;
      if (i === -1) { i = 0; c = cycle + 1; }
      return { ...t, i, cycle: c };
    });
  }

  _tick() {
    const horizon = this.ctx.currentTime + this.lookahead;
    for (const t of this.tracks) {
      for (;;) {
        const ev = t.events[t.i];
        const beat = t.cycle * t.length + ev.beat;
        const time = this.startTime + beat * this.beatDur;
        if (time > horizon) break;
        if (time >= this.ctx.currentTime - 0.02) {
          this.engine.trigger(t.inst, ev, Math.max(time, this.ctx.currentTime), ev.dur * this.beatDur, t.vol);
        }
        t.i++;
        if (t.i >= t.events.length) { t.i = 0; t.cycle++; }
      }
    }
    if (this.onBeat) {
      const beat = Math.floor((this.ctx.currentTime - this.startTime) / this.beatDur);
      if (beat !== this.lastUiBeat && beat >= 0) {
        this.lastUiBeat = beat;
        this.onBeat(beat);
      }
    }
  }
}
