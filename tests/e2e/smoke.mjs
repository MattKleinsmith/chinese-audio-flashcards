// smoke.mjs — end-to-end smoke test (PLAN §8.2). Plain Node + Playwright library, headless
// Chromium, mobile viewport 390×844. Serves site/ with scripts/serve.mjs; uses the real bundle
// in site/data if site/data/manifest.json exists, otherwise the fixture in tests/fixtures/data.
//
//   node tests/e2e/smoke.mjs            (npm run test:e2e)
//   E2E_DATA_DIR=path node tests/e2e/smoke.mjs   to force a data dir
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from '../../scripts/serve.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = process.env.E2E_DATA_DIR
  ? resolve(process.env.E2E_DATA_DIR)
  : existsSync(join(REPO, 'site/data/manifest.json')) ? join(REPO, 'site/data') : join(REPO, 'tests/fixtures/data');

// Selectors that would reveal clip length — none may exist on the study screen (hard requirement).
const FORBIDDEN = '[data-testid=duration], .progress, input[type=range], audio[controls], progress, meter';
const VIEWPORT = { width: 390, height: 844 };

let checks = 0;
const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => { checks++; console.log(`  ✓ ${msg}`); };

async function launch() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    // Fallback for environments with a preinstalled Chromium (see PLAN §1.7).
    const exe = '/opt/pw-browsers/chromium';
    if (!existsSync(exe)) throw err;
    console.warn(`default launch failed (${err.message.split('\n')[0]}); using ${exe}`);
    return chromium.launch({ headless: true, executablePath: exe });
  }
}

async function noHorizontalScroll(page, where) {
  const w = await page.evaluate(() => document.scrollingElement.scrollWidth);
  assert.ok(w <= VIEWPORT.width, `${where}: page is ${w}px wide (horizontal scroll)`);
}

async function toastText(page, previous = null) {
  await page.waitForFunction((prev) => {
    const el = document.querySelector('#toast');
    return el && !el.hidden && el.textContent && el.textContent !== prev;
  }, previous, { timeout: 5000 });
  return page.textContent('#toast');
}

async function main() {
  const words = JSON.parse(readFileSync(join(DATA_DIR, 'words.json'), 'utf8'));
  const { server, url } = await startServer({ port: 0, dataDir: DATA_DIR, quiet: true, userData: false }); // steps 11–12 mock the export themselves
  console.log(`e2e: serving ${url} with data from ${DATA_DIR} (${words.length} words)`);
  const browser = await launch();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    const clipResponses = [];
    page.on('response', (r) => { if (/\.mp3(\?|$)/.test(r.url())) clipResponses.push({ url: r.url(), status: r.status() }); });

    step('1. Open / → empty state');
    await page.goto(url);
    await page.waitForSelector('[data-testid=empty-state]');
    ok('empty state shown');
    await noHorizontalScroll(page, 'home');

    step('2. Import pasted TSV → preview → import');
    await page.click('[data-testid=cta-import]');
    await page.waitForSelector('[data-testid=import-text]');
    await page.fill('[data-testid=import-text]', '学习\t xué xí\t to study\n朋友\tpéng you\tfriend\n图书馆');
    await page.click('[data-testid=import-preview-btn]');
    await page.waitForSelector('[data-testid=preview-row]');
    assert.equal(await page.locator('[data-testid=preview-row]').count(), 3);
    ok('preview shows 3 rows');
    assert.equal(await page.inputValue('[data-testid=map-s]'), '0');
    assert.equal(await page.inputValue('[data-testid=map-p]'), '1');
    assert.equal(await page.inputValue('[data-testid=map-d]'), '2');
    assert.equal(await page.inputValue('[data-testid=map-t]'), '');
    ok('column mapping: s=col1, p=col2, d=col3');
    const firstRow = await page.locator('[data-testid=preview-row]').first().innerText();
    assert.match(firstRow, /学习[\s\S]*xué xí[\s\S]*to study/);
    await noHorizontalScroll(page, 'import');
    await page.click('[data-testid=import-confirm]');
    const t1 = await toastText(page);
    assert.match(t1, /\b3\b/, `toast "${t1}" mentions 3`);
    ok(`toast: "${t1.trim()}"`);

    step('3. Quick-add HSK 1 → home shows word cards');
    await page.check('[data-testid=hsk-1]');
    await page.click('[data-testid=hsk-add]');
    const t2 = await toastText(page, t1);
    ok(`toast: "${t2.trim()}"`);
    await page.goto(url + '#/');
    await page.waitForSelector('[data-testid=tile-sentences]');
    assert.equal(await page.locator('[data-testid=tile-words], [data-testid=tile-mixed]').count(), 0, 'Words/Mixed hidden by default');
    await page.goto(url + '#/settings');
    await page.check('[data-testid=set-showWordModes]');
    await page.goto(url + '#/');
    await page.waitForSelector('[data-testid=tile-words]');
    assert.equal(await page.locator('[data-testid=tile-mixed]').count(), 1, 'Mixed tile shown once enabled');
    const due = Number(await page.textContent('[data-testid=due-words]'));
    const fresh = Number(await page.textContent('[data-testid=new-words]'));
    assert.ok(due + fresh > 0, `words due+new = ${due}+${fresh}`);
    ok(`only Sentences by default; after enabling in Settings, Words tile: ${due} due · ${fresh} new`);

    step('4. Study a word card');
    await page.click('[data-testid=start-words]');
    await page.waitForSelector('[data-testid=replay]');
    assert.ok(await page.isVisible('[data-testid=replay]'));
    ok('replay button visible');
    assert.equal(await page.locator(FORBIDDEN).count(), 0, 'no duration / seek / progress UI');
    const audio = page.locator('audio');
    assert.equal(await audio.count(), 1, 'exactly one <audio> element');
    assert.equal(await audio.getAttribute('controls'), null, '<audio> has no controls attribute');
    ok('no duration/seek UI; single <audio> without controls');
    assert.match(await page.getAttribute('[data-testid=replay]', 'aria-label'), /^(Play|Pause|Resume) audio$/);
    // Transport controls: restart + rewind steps, speed chips; none of them shows time.
    for (const t of ['restart', 'rewind-5', 'rewind-1', 'rewind-0.5', 'rewind-0.1']) assert.ok(await page.isVisible(`[data-testid="${t}"]`), `${t} visible`);
    assert.ok((await page.locator('[data-testid=transport]').innerText()).match(/−5s.*−1s.*−.5s.*−.1s/s), 'rewind labels');
    await page.click('[data-testid="speed-0.75"]');
    await page.waitForFunction(() => Math.abs(document.querySelector('audio').playbackRate - 0.75) < 1e-6);
    assert.equal(await page.getAttribute('[data-testid="speed-0.75"]', 'aria-checked'), 'true');
    assert.equal(await page.evaluate(() => document.querySelector('audio').preservesPitch !== false), true, 'pitch preserved');
    await page.click('[data-testid=speed-1]');
    await page.waitForFunction(() => document.querySelector('audio').playbackRate === 1);
    ok('transport row + speed chips work (0.75× applied and back to 1×)');
    // Pause / resume via the big button (headless Chromium has no audio output, but state flows).
    await page.evaluate(() => document.querySelector('audio').dispatchEvent(new Event('playing')));
    await page.waitForFunction(() => document.querySelector('[data-testid=replay]').getAttribute('aria-label') === 'Pause audio');
    await page.click('[data-testid=replay]');
    await page.waitForFunction(() => document.querySelector('[data-testid=replay]').getAttribute('aria-label') === 'Resume audio');
    assert.match(await page.textContent('[data-testid=replay]'), /Paused/);
    await page.click('[data-testid=rewind-1]'); // rewinding while paused stays paused
    assert.equal(await page.getAttribute('[data-testid=replay]', 'aria-label'), 'Resume audio');
    ok('play → pause → rewind keeps paused state');
    await page.waitForFunction(() => document.querySelector('audio').src.endsWith('.mp3'));
    const src = await page.evaluate(() => document.querySelector('audio').src);
    ok(`audio.src = …${src.slice(-40)}`);
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => e.name.endsWith('.mp3')));
    await page.waitForTimeout(300);
    const clipOk = clipResponses.filter((r) => r.url === src && (r.status === 200 || r.status === 206));
    assert.ok(clipOk.length > 0, `clip request succeeded: ${JSON.stringify(clipResponses.slice(0, 5))}`);
    ok(`clip request returned ${clipOk[0].status}`);
    await noHorizontalScroll(page, 'study front');
    const label = await page.textContent('[data-testid=card-label]');
    assert.equal(label.trim(), 'Word');
    await page.click('[data-testid=reveal]');
    await page.waitForSelector('[data-testid=answer-hanzi]');
    const hanzi = (await page.textContent('[data-testid=answer-hanzi]')).trim();
    assert.match(hanzi, /\p{Script=Han}/u);
    ok(`revealed hanzi: ${hanzi}`);
    assert.equal(await page.locator(FORBIDDEN).count(), 0, 'no duration / seek UI on the back');
    assert.ok(await page.isVisible('[data-testid=replay]'), 'replay still visible on back');
    const goodLabel = await page.textContent('[data-testid=grade-good]');
    assert.match(goodLabel, /Good\s*10m/);
    await page.click('[data-testid=grade-good]');
    await page.waitForFunction(() => /^1\//.test(document.querySelector('[data-testid=session-count]')?.textContent || ''));
    ok('graded Good; session count 1/…');

    step('4b. Local data & activity screen');
    await page.goto(url + '#/settings');
    await page.click('[data-testid=open-activity]');
    await page.waitForSelector('[data-testid=ls-log] li');
    assert.match(await page.textContent('[data-testid=ls-db]'), /IndexedDB/);
    assert.match(await page.textContent('[data-testid=ls-reviews]'), /Reviews logged\s*1$/);
    assert.match(await page.textContent('[data-testid=ls-today]'), /1 reviews · 1 cards · 0 again/);
    assert.match(await page.textContent('[data-testid=ls-vocab]'), /Vocab words/);
    assert.match(await page.textContent('[data-testid=ls-log] li'), /good/);
    assert.match(await page.textContent('[data-testid=ls-usage]'), /of/);
    ok('Local data screen shows DB mode, counts, today, and the review log');

    step('5. Reload → progress persisted');
    await page.reload();
    await page.waitForFunction(() => window.__clf && window.__clf.debug);
    const dbg = await page.evaluate(() => window.__clf.debug());
    assert.equal(dbg.dbMode, 'idb');
    assert.ok(dbg.reviews >= 1, `reviews = ${dbg.reviews}`);
    assert.ok(dbg.cards >= 1, `cards = ${dbg.cards}`);
    assert.ok(dbg.stats.words.due >= 1, 'the Good card is due again today (10 min step)');
    ok(`after reload: ${dbg.vocab} vocab, ${dbg.cards} cards, ${dbg.reviews} reviews, ${dbg.stats.words.due} words due`);

    step('6. Sentence card');
    await page.goto(url + '#/import');
    await page.check('[data-testid=hsk-2]');
    await page.click('[data-testid=hsk-add]');
    await toastText(page);
    await page.goto(url + '#/study/sentences');
    await page.waitForSelector('[data-testid=replay], [data-testid=summary]');
    if (await page.locator('[data-testid=summary]').count()) {
      console.log('  (no sentences at threshold 0; setting threshold 2)');
      await page.goto(url + '#/settings');
      await page.selectOption('[data-testid=set-threshold]', '2');
      await page.goto(url + '#/study/sentences');
      await page.waitForSelector('[data-testid=replay], [data-testid=summary]');
    }
    assert.ok(await page.isVisible('[data-testid=replay]'), '≥ 1 sentence unlocked');
    assert.match(await page.textContent('[data-testid=card-label]'), /^Sentence/);
    assert.equal(await page.locator(FORBIDDEN).count(), 0);
    ok('sentence card shown, no duration UI');
    await page.click('[data-testid=reveal]');
    await page.waitForSelector('[data-testid=sentence] .tok');
    assert.equal(await page.locator('[data-testid=translation]').count(), 0, 'translation hidden by default');
    assert.equal(await page.locator('[data-testid=sentence] .py').count(), 0, 'pinyin hidden by default');
    assert.equal(await page.locator('[data-testid=sentence] .hz[class*=" t"]').count(), 0, 'no tone colours by default');
    assert.ok(await page.locator('[data-testid=sentence].unspaced').count() === 1, 'no word spacing by default');
    await page.click('[data-testid=card-spacing]');
    await page.waitForSelector('[data-testid=sentence].spaced');
    await page.click('[data-testid=card-spacing]');
    await page.waitForSelector('[data-testid=sentence].unspaced');
    ok('word-spacing chip toggles gaps between words');
    await page.click('[data-testid=card-pinyin]');
    await page.waitForSelector('[data-testid=sentence] .py');
    const tokCount = await page.locator('[data-testid=sentence] .tok').count();
    const hzCount = await page.locator('[data-testid=sentence] .tok .hz').count();
    const pyCount = await page.locator('[data-testid=sentence] .tok .py').count();
    assert.ok(tokCount >= 1 && hzCount === pyCount && pyCount >= tokCount, `tokens ${tokCount}, hz ${hzCount}, py ${pyCount}`);
    assert.equal(await page.locator('[data-testid=sentence] ruby').count(), 0, 'grid layout, not <ruby>');
    await page.click('[data-testid=card-translation]');
    await page.waitForSelector('[data-testid=translation]');
    const enText = (await page.textContent('[data-testid=translation]')).trim();
    assert.match(enText, /[A-Za-z]{2,}/, `sentence translation shown: ${enText}`);
    assert.doesNotMatch(enText, /machine translation/);
    ok(`translation chip shows: ${enText.slice(0, 50)}`);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const copied = await page.evaluate(async () => {
      const el = document.querySelector('[data-testid=sentence]');
      const range = document.createRange(); range.selectNodeContents(el);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('copy');
      return navigator.clipboard.readText();
    });
    const expectedText = await page.evaluate(() => [...document.querySelectorAll('[data-testid=sentence] .hz')].map((e) => e.textContent).join(''));
    assert.equal(copied, expectedText, 'copy yields only the characters, no pinyin');
    assert.match(copied, /^\p{Script=Han}+$/u);
    ok(`copied selection is hanzi only: ${copied}`);
    const hzToneClasses = await page.locator('[data-testid=sentence] .hz[class*=" t"]').count();
    assert.ok(hzToneClasses >= 1, 'characters carry tone classes');
    await page.click('[data-testid=card-pinyin]'); // chip on the card itself: off again
    await page.waitForSelector('[data-testid=sentence].no-pinyin');
    assert.equal(await page.getAttribute('[data-testid=card-pinyin]', 'aria-checked'), 'false');
    assert.equal(await page.locator('[data-testid=sentence] .py').count(), 0, 'pinyin hidden');
    assert.equal(await page.locator('[data-testid=sentence] .hz[class*=" t"]').count(), 0, 'tone colours hidden with pinyin');
    await page.click('[data-testid=menu]');
    await page.click('[data-testid=menu-pinyin]');
    await page.waitForSelector('[data-testid=sentence]:not(.no-pinyin) .py');
    ok('pinyin chip toggles pinyin and tone colours; the menu item does the same');
    const pyBelow = await page.evaluate(() => {
      const t = document.querySelector('[data-testid=sentence] .tok');
      return t.querySelector('.py').getBoundingClientRect().top >= t.querySelector('.hz').getBoundingClientRect().bottom - 2;
    });
    assert.ok(pyBelow, 'pinyin row sits under the hanzi row');
    ok(`${tokCount} tokens with per-character pinyin (${pyCount} syllables)`);
    await noHorizontalScroll(page, 'sentence back');
    await page.locator('[data-testid=sentence] .tok').first().click();
    await page.waitForSelector('[data-testid=popover]');
    const pop = await page.textContent('[data-testid=popover]');
    ok(`popover: "${pop.replace(/\s+/g, ' ').trim().slice(0, 60)}"`);
    await page.click('[data-testid=grade-good]');

    step('7. Export backup');
    await page.goto(url + '#/settings');
    await page.waitForSelector('[data-testid=about-sources] li');
    assert.ok((await page.locator('[data-testid=about-sources] li').count()) >= 2, 'About lists manifest sources');
    ok('About lists sources with licences');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export-backup]')]);
    assert.match(download.suggestedFilename(), /^clf-backup-\d{8}\.json$/);
    const backupPath = await download.path();
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
    const expected = new Set([...words.filter((w) => w.hsk === 1 || w.hsk === 2).map((w) => w.s), '学习', '朋友', '图书馆']).size;
    assert.equal(backup.vocab.length, expected, `vocab length ${backup.vocab.length} = HSK1+2 ∪ imports (${expected})`);
    assert.ok(backup.vocab.length >= Math.min(150, expected));
    assert.ok(backup.reviews.length >= 2 && backup.cards.length >= 2);
    ok(`${download.suggestedFilename()}: ${backup.vocab.length} vocab, ${backup.cards.length} cards, ${backup.reviews.length} reviews`);

    step('8. Delete all → restore backup');
    await page.click('[data-testid=delete-all]');
    await page.waitForSelector('[data-testid=empty-state]');
    ok('delete all → empty state');
    await page.goto(url + '#/settings');
    await page.setInputFiles('[data-testid=restore-file]', backupPath);
    await page.waitForSelector('[data-testid=tile-words]');
    const restored = await page.evaluate(() => window.__clf.debug());
    assert.equal(restored.vocab, backup.vocab.length);
    assert.equal(restored.reviews, backup.reviews.length);
    ok(`restored ${restored.vocab} vocab, ${restored.reviews} reviews`);

    step('9. Service worker + clip cache');
    const swOk = await page.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]));
    assert.ok(swOk, 'service worker became ready');
    const cached = await page.evaluate(async () => (await (await caches.open('clips-v1')).keys()).length);
    assert.ok(cached >= 1, `clips-v1 has ${cached} entries`);
    ok(`service worker ready; clips-v1 holds ${cached} clips`);

    step('10. Autoplay blocked → button stays a plain Play (NotAllowedError fallback)');
    const ctx2 = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx2.addInitScript(() => {
      HTMLMediaElement.prototype.play = function play() { return Promise.reject(new DOMException('blocked', 'NotAllowedError')); };
    });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => errors.push(e.message));
    await p2.goto(url + '#/import');
    await p2.check('[data-testid=hsk-1]');
    await p2.click('[data-testid=hsk-add]');
    await toastText(p2);
    await p2.goto(url + '#/study/words');
    await p2.waitForSelector('[data-testid=replay].blocked');
    assert.doesNotMatch(await p2.textContent('[data-testid=replay]'), /Tap to play|Paused|failed/);
    assert.equal(await p2.getAttribute('[data-testid=replay]', 'aria-label'), 'Play audio');
    ok('blocked autoplay leaves a plain Play button with no hint text');
    await ctx2.close();

    step('11. Automatic Hack Chinese sync from data/user/*');
    const ctx3 = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    let sha = 'a'.repeat(64);
    let csv = '\ufeffsimplified,pinyin,definition\r\n学习,xué xí,to study\r\n朋友,péng you,friend\r\n"图书馆","tú shū guǎn","library"\r\n';
    await ctx3.route('**/data/user/sync.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'hackchinese', syncedAt: new Date().toISOString(), rows: 4, sha256: sha }) }));
    await ctx3.route('**/data/user/hackchinese.csv*', (r) => r.fulfill({ status: 200, contentType: 'text/csv; charset=utf-8', body: csv }));
    const p3 = await ctx3.newPage();
    p3.on('pageerror', (e) => errors.push(e.message));
    await p3.goto(url + '#/');
    const t3 = await toastText(p3);
    assert.match(t3, /Hack Chinese: \+3 new words/);
    await p3.waitForFunction(() => document.querySelector('[data-testid=stat-vocab]')?.textContent.trim() === '3');
    const dbg3 = await p3.evaluate(() => window.__clf.debug());
    assert.equal(dbg3.vocab, 3);
    assert.match(await p3.textContent('[data-testid=home-sync]'), /Hack Chinese: 3 words · export just now/);
    ok('3 words auto-imported from the mocked export; home shows sync status');
    // Same export again (same sha) → no re-import; a changed export with one word gone and one
    // added → +1 by default (no deletions) and −1 once "mirror deletions" is on.
    await p3.goto(url + '#/settings');
    await p3.click('[data-testid=sync-now]');
    await p3.waitForFunction(() => /checked just now/.test(document.querySelector('[data-testid=sync-status]')?.textContent || ''));
    assert.equal((await p3.evaluate(() => window.__clf.debug())).vocab, 3);
    sha = 'b'.repeat(64);
    csv = 'simplified\n学习\n朋友\n老师\n';
    await p3.click('[data-testid=sync-now]');
    await p3.waitForFunction(() => /\+1/.test(document.querySelector('[data-testid=sync-status]')?.textContent || ''));
    assert.equal((await p3.evaluate(() => window.__clf.debug())).vocab, 4);
    await p3.check('[data-testid=set-mirrorHcDeletions]');
    sha = 'c'.repeat(64);
    await p3.click('[data-testid=sync-now]');
    await p3.waitForFunction(() => /−1/.test(document.querySelector('[data-testid=sync-status]')?.textContent || ''));
    assert.equal((await p3.evaluate(() => window.__clf.debug())).vocab, 3);
    ok('unchanged export is a no-op; changed export adds; mirror deletions removes');
    await ctx3.close();

    step('11b. Update detection: changed ETag on foreground → reload offered / performed');
    const ctx5 = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    let etag = '"v1"';
    await ctx5.route('**/index.html', (r) => (r.request().method() === 'HEAD' ? r.fulfill({ status: 200, headers: { etag, 'last-modified': 'Fri, 25 Sep 2026 10:00:00 GMT' } }) : r.continue()));
    const p5 = await ctx5.newPage();
    p5.on('pageerror', (e) => errors.push(e.message));
    await p5.goto(url + '#/settings');
    await p5.waitForFunction(() => window.__clf?.app?.siteVersion?.());
    assert.ok(await p5.isVisible('[data-testid=reload-app]'), 'Reload app button');
    await p5.click('[data-testid=check-update]');
    assert.match(await toastText(p5), /latest version/);
    etag = '"v2"';
    await p5.goto(url + '#/study/sentences'); // mid-session: must not auto-reload
    await p5.waitForSelector('[data-testid=replay], [data-testid=summary]');
    const r5 = await p5.evaluate(() => window.__clf.app.checkForUpdate());
    assert.equal(r5.status, 'changed');
    assert.match(await p5.textContent('#toast'), /New version available/);
    assert.ok(await p5.isVisible('#toast .toast-action'), 'Reload action offered while studying');
    ok('changed site version → Reload offered mid-session (no forced reload)');
    await ctx5.close();

    step('12. No export in the site → silent');
    const ctx4 = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await ctx4.route('**/data/user/*', (r) => r.fulfill({ status: 404, body: 'not found' }));
    const p4 = await ctx4.newPage();
    p4.on('pageerror', (e) => errors.push(e.message));
    await p4.goto(url + '#/');
    await p4.waitForSelector('text=Import from Hack Chinese');
    await p4.waitForTimeout(500);
    assert.equal(await p4.locator('[data-testid=home-sync]').count(), 0, 'no sync line without an export');
    ok('no export file → nothing shown, no errors');
    await ctx4.close();

    assert.deepEqual(errors, [], 'no uncaught page errors');
    ok('no uncaught page errors');
    console.log(`\ne2e smoke: all ${checks} checks passed`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('\n✗ e2e smoke FAILED:', err);
  process.exit(1);
});
