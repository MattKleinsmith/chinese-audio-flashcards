// audio.js — AudioPlayer: one reused <audio> element, replay-from-start, clip preloading.
//
// HARD REQUIREMENT (PLAN §0.3 / §5.4): the UI must never reveal a clip's length. This module
// therefore exposes NO duration, currentTime, progress or seek API, the <audio> element never
// gets the `controls` attribute, and callers only ever learn "playing / ended / blocked /
// error". Do not add elapsed time, a progress bar, a duration label or a waveform anywhere.
//
// Mobile autoplay: browsers block play() before a user gesture. Call unlock() synchronously
// inside the tap that starts a session (it plays a tiny silent clip on the same element), and
// reuse this element for every card so later play() calls are allowed. If play() is still
// rejected with NotAllowedError the state becomes "blocked" and the UI shows "Tap to play".

export const CLIP_CACHE = 'clips-v1';

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
    this.el.addEventListener('playing', () => this._set('playing'));
    this.el.addEventListener('ended', () => this._set('ended'));
    this.el.addEventListener('pause', () => { if (this.state === 'playing') this._set('ended'); });
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

  /** Stop playback (used when leaving the study screen). */
  stop() {
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
