// main.js — boot sequence, hash router and screen switching.
// Routes (PLAN §5.1): #/ home · #/study/:mode (words|sentences|mixed) · #/import · #/vocab ·
// #/settings. Each screen module exports render(root, app, params) and may return a cleanup
// function that runs when the route changes.

import { openDB, getMeta, setMeta } from './db.js';
import { loadData, DATA_DIR } from './data.js';
import { syncFromBundle } from './sync.js';
import { createAppState } from './state.js';
import { AudioPlayer } from './audio.js';
import { h, clear, toast, banner, dismissToast } from './util.js';
import * as home from './screens/home.js';
import * as study from './screens/study.js';
import * as importScreen from './screens/import.js';
import * as vocab from './screens/vocab.js';
import * as settings from './screens/settings.js';
import * as activity from './screens/activity.js';

const ROUTES = [
  { re: /^#?\/?$/, screen: home, name: 'home' },
  { re: /^#\/study\/(words|sentences|mixed)$/, screen: study, name: 'study' },
  { re: /^#\/import$/, screen: importScreen, name: 'import' },
  { re: /^#\/vocab$/, screen: vocab, name: 'vocab' },
  { re: /^#\/settings$/, screen: settings, name: 'settings' },
  { re: /^#\/activity$/, screen: activity, name: 'activity' },
];

const root = document.getElementById('app');
let cleanup = null;
let app = null;

/** Build SHA injected by the Pages workflow ("dev" when running locally). */
function buildSha() {
  const v = document.querySelector('meta[name="app-build"]')?.content || '';
  return v && !v.startsWith('__') ? v : 'dev';
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  if (!app) return;
  const hash = location.hash || '#/';
  let match = null; let params = [];
  for (const r of ROUTES) {
    const m = hash.match(r.re);
    if (m) { match = r; params = m.slice(1); break; }
  }
  if (!match) { location.replace('#/'); return; }
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  dismissToast();
  document.body.dataset.route = match.name;
  document.getElementById('nav-back').hidden = match.name === 'home';
  clear(root);
  try {
    cleanup = match.screen.render(root, app, params) || null;
  } catch (err) {
    console.error(err);
    root.append(h('div', { class: 'screen' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, String(err.message || err)),
      h('a', { class: 'btn', href: '#/' }, 'Home')));
  }
  window.scrollTo(0, 0);
}

function showFatal(message) {
  clear(root);
  root.append(h('div', { class: 'screen empty' },
    h('h2', {}, 'Could not load the audio bundle'),
    h('p', { class: 'muted' }, message),
    location.protocol === 'file:'
      ? h('p', {}, 'Browsers block loading data from file:// pages. Run ', h('code', {}, 'npm run serve'), ' and open http://localhost:8080.')
      : h('p', {}, 'Check your connection and reload.'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Reload')));
}

async function boot() {
  const db = await openDB();
  if (db.mode === 'memory') {
    banner('Storage is unavailable (private browsing?). Your progress will be lost when you close this tab.');
  }
  let data;
  try {
    data = await loadData(DATA_DIR);
  } catch (err) {
    console.error(err);
    showFatal(String(err.message || err));
    return;
  }
  const state = await createAppState(db, data);
  const player = new AudioPlayer(document.getElementById('player'));
  player.setRate(state.settings.rate);

  app = { state, data, player, db, navigate, toast, buildSha: buildSha(), session: null };
  window.__clf = {
    app,
    /** Counts for tests and debugging. */
    debug: async () => ({ ...(await state.debug()), route: location.hash || '#/', session: app.session ? { ...app.session } : null, buildSha: app.buildSha }),
  };

  // "Audio bundle updated" toast when the data build changed since the last open.
  const prevBuilt = await getMeta(db, 'dataBuiltAt');
  const builtAt = data.manifest.builtAt || '';
  if (prevBuilt && builtAt && prevBuilt !== builtAt) setTimeout(() => toast('Audio bundle updated'), 300);
  await setMeta(db, 'dataBuiltAt', builtAt);
  await setMeta(db, 'lastOpen', Date.now());

  window.addEventListener('hashchange', route);
  route();

  // Automatic Hack Chinese sync: on open and whenever the app returns to the foreground.
  const runSync = async (force = false) => {
    const r = await syncFromBundle(app, { force, dataDir: DATA_DIR });
    if (r.status === 'synced' && (r.added || r.removed)) {
      toast(`Hack Chinese: ${r.added ? `+${r.added} new word${r.added === 1 ? '' : 's'}` : ''}${r.added && r.removed ? ', ' : ''}${r.removed ? `−${r.removed} removed` : ''}`);
      if ((location.hash || '#/') === '#/' || location.hash.startsWith('#/vocab')) route();
    }
    return r;
  };
  app.sync = runSync;
  runSync();

  // Ask the browser not to evict our IndexedDB/cache under storage pressure (best effort; iOS
  // grants it for installed home-screen apps, Chrome/Firefox for engaged or installed sites).
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* ignore */ }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(); });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker registration failed', err));
  }
}

boot().catch((err) => { console.error(err); showFatal(String(err.message || err)); });
