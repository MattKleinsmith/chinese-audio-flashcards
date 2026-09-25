// audio.js — AudioPlayer: one reused <audio> element with transport controls (play / pause /
// resume, relative rewind, restart, playback rate) and clip preloading.
//
// HARD REQUIREMENT (PLAN §0.3 / §5.4): the UI must never reveal a clip's length. This module
// therefore exposes NO duration, elapsed time or absolute-seek API; rewinding is relative
// ("go back 1 s"), the <audio> element never gets the `controls` attribute, and callers only
// learn the playback state. Do not add elapsed time, a progress bar, a duration label or a
// waveform anywhere.
//
// Playback rate keeps the pitch (preservesPitch), so slowed or sped-up speech does not change
// the speaker's voice, only the tempo.
//
// Mobile autoplay: browsers block play() before a user gesture. Call unlock() synchronously
// inside the tap that starts a session (it plays a tiny silent clip on the same element), and
// reuse this element for every card so later play() calls are allowed. If play() is still
// rejected with NotAllowedError the state becomes "blocked" and the UI shows "Tap to play".

export const CLIP_CACHE = 'clips-v1';

/** Playback speeds offered in the UI (pitch is preserved at every speed). */
export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5];

/** Rewind steps offered in the UI, in seconds (small ones are meant to be tapped repeatedly). */
export const REWIND_STEPS = [5, 1, 0.5, 0.1];

// 50 ms of silence, 418-byte MP3.
const SILENT_MP3 = 'data:audio/mpeg;base64,//NAxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEWwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==';

export class AudioPlayer {
  /** @param {HTMLAudioElement} [el] the single shared element (created if omitted) */
  constructor(el) {
    this.el = el || document.createElement('audio');
    this.el.removeAttribute('controls'); // see HARD REQUIREMENT above
    this.el.preload = 'auto';
    this.url = '';
    this.rate = 1;
    this.state = 'idle';
    this.listeners = new Set();
    this.unlocked = false;
    this._userPaused = false;
    try { this.el.preservesPitch = true; this.el.webkitPreservesPitch = true; } catch { /* ignore */ }
    this.el.addEventListener('playing', () => { this._userPaused = false; this._set('playing'); });
    this.el.addEventListener('ended', () => this._set('ended'));
    this.el.addEventListener('pause', () => {
      if (this.el.ended) this._set('ended');
      else if (this._userPaused) this._set('paused');
      else if (this.state === 'playing') this._set('ended');
    });
    this.el.addEventListener('error', () => { if (this.url && !this.el.src.startsWith('data:')) this._set('error'); });
  }

  /** Subscribe to state changes; returns an unsubscribe function. */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    for (const fn of this.listeners) { try { fn(state); } catch (e) { console.error(e); } }
  }

  /** Must be called synchronously inside a user gesture (e.g. the Start button tap). */
  unlock() {
    if (this.unlocked) return;
    try {
      this.el.src = SILENT_MP3;
      const p = this.el.play();
      if (p && p.then) p.then(() => { this.unlocked = true; }, () => {});
    } catch { /* ignore */ }
  }

  setRate(rate) {
    this.rate = Number(rate) || 1;
    try { this.el.playbackRate = this.rate; } catch { /* ignore */ }
  }

  /** Select a clip without playing it. */
  load(url) {
    if (this.url === url) return;
    this._userPaused = false;
    this.url = url;
    this.el.src = url;
    this._set('idle');
  }

  /**
   * Play `url` (or the current clip) from the start.
   * Resolves to 'playing' | 'blocked' | 'error' | 'aborted' — never rejects.
   */
  async play(url = this.url) {
    if (!url) return 'error';
    if (url !== this.url || !this.el.src.endsWith(url.replace(/^\.\//, ''))) { this.url = url; this.el.src = url; }
    this._userPaused = false;
    try { this.el.currentTime = 0; } catch { /* not seekable yet; fine */ }
    this.el.playbackRate = this.rate;
    this._set('loading');
    try {
      await this.el.play();
      this.unlocked = true;
      return 'playing';
    } catch (err) {
      if (err && err.name === 'NotAllowedError') { this._set('blocked'); return 'blocked'; }
      if (err && err.name === 'AbortError') return 'aborted'; // src changed mid-load
      this._set('error');
      return 'error';
    }
  }

  /** Replay the current clip from the start. */
  replay() { return this.play(this.url); }

  /** Restart from the beginning (alias kept for readability at call sites). */
  restart() { return this.play(this.url); }

  /** Pause, keeping the position so resume() continues from there. */
  pause() {
    if (this.state !== 'playing' && this.state !== 'loading') return;
    this._userPaused = true;
    try { this.el.pause(); } catch { /* ignore */ }
    this._set('paused');
  }

  /** Resume from the paused position (or start from the beginning if nothing is loaded). */
  async resume() {
    if (!this.url) return 'error';
    if (this.state !== 'paused') return this.play(this.url);
    this.el.playbackRate = this.rate;
    try { await this.el.play(); return 'playing'; } catch (err) {
      if (err && err.name === 'NotAllowedError') { this._set('blocked'); return 'blocked'; }
      if (err && err.name === 'AbortError') return 'aborted';
      this._set('error'); return 'error';
    }
  }

  /** Play/pause toggle: playing → pause; paused → resume; idle/ended/blocked → play from start. */
  toggle() {
    if (this.state === 'playing' || this.state === 'loading') { this.pause(); return Promise.resolve('paused'); }
    if (this.state === 'paused') return this.resume();
    return this.play(this.url);
  }

  /**
   * Move the playhead by `seconds` (negative = rewind), clamped at the start. Playing stays
   * playing, paused stays paused, and a finished or idle clip starts playing from the new
   * position. The position itself is never exposed.
   */
  seekBy(seconds) {
    if (!this.url) return;
    const delta = Number(seconds) || 0;
    let t = 0;
    try { t = Math.max(0, (this.el.currentTime || 0) + delta); this.el.currentTime = t; } catch { /* not seekable yet */ }
    if (this.state === 'playing' || this.state === 'paused' || this.state === 'loading') return;
    // ended / idle / blocked: start playing from the new position
    this.el.playbackRate = this.rate;
    this._set('loading');
    this.el.play().then(() => { this.unlocked = true; }, (err) => {
      if (err && err.name === 'NotAllowedError') this._set('blocked');
      else if (!(err && err.name === 'AbortError')) this._set('error');
    });
  }

  /** Stop playback (used when leaving the study screen). */
  stop() {
    this._userPaused = false;
    try { this.el.pause(); } catch { /* ignore */ }
    this._set('idle');
  }
}

/**
 * Fetch a clip into the Cache API (clips-v1) so it plays offline later.
 * Resolves true if cached; never throws.
 */
export async function preload(url) {
  try {
    if (typeof caches === 'undefined' || !url) return false;
    const abs = new URL(url, location.href).href;
    const cache = await caches.open(CLIP_CACHE);
    if (await cache.match(abs)) return true;
    const res = await fetch(abs);
    if (!res.ok) return false;
    // The service worker may already have stored it while serving this fetch.
    if (!(await cache.match(abs))) await cache.put(abs, res.clone());
    return true;
  } catch {
    return false;
  }
}
