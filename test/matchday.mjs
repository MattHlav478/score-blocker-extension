/**
 * Match Day tests: the optional aggressive layers.
 *
 * The most important check in this file is the first one — with Match Day off,
 * behaviour must be exactly what ships without the feature.
 *
 * Run with: node test/matchday.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

async function loadPlaywright() {
  let mod;
  try {
    mod = await import('playwright');
  } catch (err) {
    const root = execSync('npm root -g').toString().trim();
    mod = await import(pathToFileURL(path.join(root, 'playwright', 'index.js')).href);
  }
  return mod.chromium ? mod : mod.default;
}
const { chromium } = await loadPlaywright();

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(TEST_DIR, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'score-blocker-matchday-'));
const PORT = 8855;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ---- static check: the two selector lists must not drift -------------------
{
  const css = fs.readFileSync(path.join(SRC, 'content', 'lockdown.css'), 'utf8');
  const defaults = fs.readFileSync(path.join(SRC, 'common', 'defaults.js'), 'utf8');
  const listed = defaults
    .slice(defaults.indexOf('const SB_DESCRIPTION_SELECTORS'), defaults.indexOf('SB_DESCRIPTION_SELECTORS.join'))
    .match(/'([^']+)'/g)
    .map((s) => s.replace(/'/g, ''));
  // Every selector declared in JS must appear in the stylesheet, and the
  // stylesheet must not blur anything the JS does not know how to reveal.
  const body = css.slice(css.lastIndexOf('*/') + 2);
  const missing = listed.filter((sel) => !body.includes(sel));
  const cssSelectors = new Set(
    body
      .split('{')[0]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const extra = [...cssSelectors].filter((sel) => !listed.includes(sel));
  check('lockdown.css and defaults.js declare the same selectors',
    missing.length === 0 && extra.length === 0,
    `missing in css: ${JSON.stringify(missing)}, extra in css: ${JSON.stringify(extra)}`);
}

const server = http.createServer((req, res) => {
  const name = req.url.split('?')[0].replace(/^\//, '') || 'google.html';
  fs.readFile(path.join(TEST_DIR, 'fixtures', path.basename(name)), (e, d) => {
    res.writeHead(e ? 404 : 200, { 'Content-Type': 'text/html' });
    res.end(d || 'not found');
  });
});
await new Promise((r) => server.listen(PORT, r));

const ext = path.join(WORK, 'ext');
fs.cpSync(SRC, ext, { recursive: true, filter: (s) => !s.includes('/.git') });
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
manifest.content_scripts[0].matches = ['http://localhost/*'];
manifest.host_permissions = ['http://localhost/*'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
const defaultsPath = path.join(ext, 'common', 'defaults.js');
fs.writeFileSync(
  defaultsPath,
  fs
    .readFileSync(defaultsPath, 'utf8')
    .replace("['https://www.google.com/*', 'https://www.youtube.com/*']", "['http://localhost/*']")
);

const context = await chromium.launchPersistentContext(path.join(WORK, 'profile'), {
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
const worker =
  context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
await worker.evaluate(
  () =>
    new Promise((resolve) => {
      const poll = () =>
        chrome.storage.sync.get('enabled', (v) =>
          v.enabled === undefined ? setTimeout(poll, 25) : resolve()
        );
      poll();
    })
);

const setSettings = (patch) =>
  worker.evaluate((p) => new Promise((r) => chrome.storage.sync.set(p, r)), patch);
const registeredIds = () =>
  worker.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id).sort())
  );

const blurred = (page, selector) =>
  page.$$eval(selector, (els) => els.filter((e) => getComputedStyle(e).filter.includes('blur')).length);

// ---- Match Day OFF: the regression guard ----------------------------------
const google = await context.newPage();
await google.goto(`http://localhost:${PORT}/google.html`);
await google.waitForTimeout(1200);

const scoreMasksOff = await google.$$eval('.sb-masked', (e) => e.length);
check('match day off: score masks still applied as before', scoreMasksOff > 0, `${scoreMasksOff} masks`);
check('match day off: no descriptions blurred',
  (await blurred(google, '.VwiC3b')) === 0);
check('match day off: no blocks masked',
  (await google.$$eval('.sb-block-masked', (e) => e.length)) === 0);
check('match day off: lockdown stylesheet not registered',
  !(await registeredIds()).includes('sb-lockdown'), JSON.stringify(await registeredIds()));

// ---- Match Day ON ---------------------------------------------------------
await setSettings({ matchDay: true });
await google.waitForTimeout(900);

check('match day on: lockdown stylesheet registered',
  (await registeredIds()).includes('sb-lockdown'), JSON.stringify(await registeredIds()));

const reloaded = await context.newPage();
await reloaded.goto(`http://localhost:${PORT}/google.html`);
await reloaded.waitForTimeout(1200);

const totalDescriptions = await reloaded.$$eval('.VwiC3b', (e) => e.length);
check('match day on: every description is blurred',
  (await blurred(reloaded, '.VwiC3b')) === totalDescriptions,
  `${await blurred(reloaded, '.VwiC3b')} of ${totalDescriptions}`);

const spoilerBlocks = await reloaded.$$eval('.sb-block-masked', (els) => els.map((e) => e.textContent.trim()));
check('match day on: a no-digit spoiler headline masks its whole block',
  spoilerBlocks.some((t) => t.includes('stun') && t.includes('Arsenal') && t.length < 200),
  JSON.stringify(spoilerBlocks));
check('match day on: the spoiler mask does not swallow unrelated results',
  spoilerBlocks.every((t) => !t.includes('tax return')), JSON.stringify(spoilerBlocks));

// Clicking reveals one description only.
await reloaded.click('.VwiC3b');
await reloaded.waitForTimeout(350);
const revealedCount = await reloaded.$$eval('.VwiC3b.sb-revealed', (e) => e.length);
const stillBlurred = await blurred(reloaded, '.VwiC3b');
check('match day on: clicking reveals one description, others stay hidden',
  revealedCount === 1 && stillBlurred === totalDescriptions - 1,
  `revealed ${revealedCount}, still blurred ${stillBlurred}`);

// ---- thumbnails: sports-gated --------------------------------------------
const yt = await context.newPage();
await yt.goto(`http://localhost:${PORT}/youtube.html`);
await yt.waitForTimeout(1400);

const thumbState = await yt.$$eval('ytd-video-renderer', (els) =>
  els.map((el) => ({
    title: el.querySelector('#video-title').textContent.trim(),
    blurred: Boolean(el.querySelector('img.sb-thumb-blurred'))
  }))
);
const pasta = thumbState.find((t) => t.title.includes('pasta'));
const sports = thumbState.filter((t) => !t.title.includes('pasta'));
check('match day on: thumbnails blurred on sports-looking results',
  sports.length > 0 && sports.every((t) => t.blurred), JSON.stringify(thumbState));
check('match day on: the non-sports result keeps its thumbnail',
  pasta && !pasta.blurred, JSON.stringify(pasta));

check('match day on: comments section hidden as one block',
  (await yt.$$eval('ytd-comments.sb-block-masked, #comments.sb-block-masked', (e) => e.length)) > 0);

// ---- scan cost with the digit gate lifted ---------------------------------
// Inject a realistic burst of new results and time how long the extension takes
// to have them all masked. Covers the observer, the debounce and the widened
// walk together, so a regression in any of them shows up here.
const scanMs = await yt.evaluate(() => {
  const contents = document.getElementById('contents');
  const before = document.querySelectorAll('.sb-block-masked').length;
  for (let i = 0; i < 50; i++) {
    const el = document.createElement('ytd-video-renderer');
    el.innerHTML =
      '<span id="video-title">Liverpool stun Everton in derby collapse</span>' +
      '<div class="metadata-snippet-text">Reaction and analysis.</div>';
    contents.appendChild(el);
  }
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (document.querySelectorAll('.sb-block-masked').length >= before + 50) {
        resolve(performance.now() - start);
        return;
      }
      if (performance.now() - start > 5000) return resolve(Infinity);
      requestAnimationFrame(tick);
    };
    tick();
  });
});
// 150ms of that is the observer's deliberate debounce.
check('match day on: 50 new results are all masked within budget',
  scanMs < 1000, `${scanMs === Infinity ? 'timed out' : scanMs.toFixed(0) + 'ms'} for 50 results`);

// ---- Match Day OFF mid-session -------------------------------------------
await setSettings({ matchDay: false });
await reloaded.waitForTimeout(900);
const afterOff = await reloaded.evaluate(() => ({
  blocks: document.querySelectorAll('.sb-block-masked').length,
  revealed: document.querySelectorAll('.sb-revealed').length,
  roles: document.querySelectorAll('.VwiC3b[role="button"]').length
}));
check('match day off mid-session: every block restored, no leftover attributes',
  afterOff.blocks === 0 && afterOff.revealed === 0 && afterOff.roles === 0,
  JSON.stringify(afterOff));
check('match day off mid-session: lockdown stylesheet unregistered',
  !(await registeredIds()).includes('sb-lockdown'), JSON.stringify(await registeredIds()));

// ---- options page keeps Match Day across a save ---------------------------
await setSettings({ matchDay: true });
const extensionId = new URL(worker.url()).host;
const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/options/options.html`);
await options.waitForTimeout(400);
await options.click('#save');
await options.waitForTimeout(500);
const matchDayAfterSave = await worker.evaluate(
  () => new Promise((r) => chrome.storage.sync.get('matchDay', (v) => r(v.matchDay)))
);
check('options: saving does not switch Match Day off', matchDayAfterSave === true, String(matchDayAfterSave));

await context.close();
server.close();
fs.rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
