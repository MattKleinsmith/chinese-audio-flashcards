// update.js — keeps a long-lived (home-screen) install fresh.
//
// Why: iOS resumes a home-screen web app from its frozen state instead of navigating, and
// GitHub Pages serves files with max-age=600, so a user can keep seeing an old build for a
// long time. Two independent mechanisms fix that:
//   1. The service worker is registered with updateViaCache: 'none' and asked to update
//      whenever the app returns to the foreground; a new worker triggers `controllerchange`.
//   2. Independently of the worker, the app records index.html's ETag at start-up and
//      re-checks it (HEAD, no-cache) on every return to the foreground. A changed ETag means a
//      new deploy: reload right away when not mid-session, otherwise offer a Reload toast.
// Both are best effort and never throw.

const CHECK_THROTTLE_MS = 60 * 1000;

/** Pure: given the current and previous version tags, is a reload needed? Unit-tested. */
export function versionChanged(prev, next) {
  if (!prev || !next) return false;
  return prev !== next;
}

/** Pure: whether it is safe to reload without asking (not in the middle of studying). */
export function safeToAutoReload(hash) {
  return !/^#\/study\//.test(hash || '');
}

async function headVersion(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
    if (!res.ok) return null;
    return { etag: res.headers.get('etag') || '', modified: res.headers.get('last-modified') || '' };
  } catch { return null; }
}

export function installUpdater(app, { toast, url = './index.html' } = {}) {
  let known = null; let lastCheck = 0; let pending = false;
  const tag = (v) => (v ? v.etag || v.modified : '');

  const reloadNow = () => { try { location.reload(); } catch { /* ignore */ } };
  const offer = (why) => {
    if (pending) return;
    pending = true;
    if (safeToAutoReload(location.hash)) { toast?.('Updating to the latest version…', { ms: 1500 }); setTimeout(reloadNow, 400); return; }
    toast?.(`New version available${why ? ` (${why})` : ''}`, { ms: 15000, action: { label: 'Reload', onClick: reloadNow } });
    pending = false; // allow the offer again on the next foreground if the user ignored it
  };

  // Mechanism 2: ETag / Last-Modified of index.html.
  const check = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastCheck < CHECK_THROTTLE_MS) return { status: 'throttled', version: known };
    lastCheck = now;
    const v = await headVersion(url);
    if (!v) return { status: 'offline', version: known };
    if (!known) { known = v; return { status: 'recorded', version: v }; }
    if (versionChanged(tag(known), tag(v))) { known = v; offer('site updated'); return { status: 'changed', version: v }; }
    return { status: 'same', version: v };
  };
  check(true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });

  // Mechanism 1: service worker updates.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) offer('app updated');
      hadController = true;
    });
  }

  app.checkForUpdate = () => check(true);
  app.siteVersion = () => known;
  return { check };
}
