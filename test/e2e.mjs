/**
 * End-to-end tests for Score Blocker.
 *
 * Loads the real extension into Chromium against local fixtures that mimic
 * Google and YouTube result markup. Run with: node test/e2e.mjs
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
    // Fall back to a global install, which ESM will not resolve on its own.
    const root = execSync('npm root -g').toString().trim();
    mod = await import(pathToFileURL(path.join(root, 'playwright', 'index.js')).href);
  }
  // A global (CommonJS) install exposes everything under `default`.
  return mod.chromium ? mod : mod.default;
}
const { chromium } = await loadPlaywright();

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(TEST_DIR, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'score-blocker-e2e-'));
const EXT = path.join(WORK, 'ext');
const PORT = 8899;

// Copy the extension and widen matches to localhost so fixtures exercise the
// same code path as google/youtube.
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(SRC, EXT, { recursive: true, filter: (s) => !s.includes('/.git') });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
manifest.content_scripts[0].matches = ['http://localhost/*'];
manifest.host_permissions = ['http://localhost/*'];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

const server = http.createServer((req, res) => {
  const name = req.url.split('?')[0].replace(/^\//, '') || 'google.html';
  const file = path.join(TEST_DIR, 'fixtures', path.basename(name));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(PORT, r));

const userDataDir = path.join(WORK, 'profile');
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    '--headless=new',
    '--no-sandbox',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`
  ]
});

let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const setSettings = async (patch) => {
  await worker.evaluate((p) => new Promise((r) => chrome.storage.sync.set(p, r)), patch);
};

const masks = (page) =>
  page.$$eval('.sb-masked', (els) => els.map((e) => e.textContent));

// ---- Google fixture --------------------------------------------------------
const page = await context.newPage();
await page.goto('http://localhost:' + PORT + '/google.html');
await page.waitForTimeout(1200);

let found = await masks(page);
check('google: numeric+keyword rule masks "2-1" in title and snippet',
  found.filter((t) => t.trim() === '2-1').length >= 2, JSON.stringify(found));
const teamBlock = await page.$$eval('[data-hveid="2"] .sb-masked', (els) => els.map((e) => e.textContent));
check('google: team-list rule masks both scores in "Chelsea 3 Arsenal 0"',
  teamBlock.join(',') === '3,0', JSON.stringify(teamBlock));
check('google: no false positive on "12-14 degrees"',
  !found.some((t) => t.includes('12-14')), JSON.stringify(found));
check('google: no false positive on "6-9 in the morning"',
  !found.some((t) => t.includes('6-9')), JSON.stringify(found));

const marker = await page.$$eval('.sb-marker', (e) => e.length);
check('google: hidden-content marker rendered next to each mask', marker === found.length, `${marker} markers / ${found.length} masks`);

// blur actually applied?
const blurred = await page.$eval('.sb-masked', (e) => getComputedStyle(e).filter);
check('google: mask is visually blurred', /blur\(/.test(blurred), blurred);

// click to reveal
await page.click('.sb-masked');
await page.waitForTimeout(400); // let the reveal transition finish
const revealed = await page.$eval('.sb-masked', (e) => e.classList.contains('sb-revealed') && getComputedStyle(e).filter);
check('google: click reveals the mask', revealed === 'none', String(revealed));

// hover must NOT reveal by default
await page.hover('.sb-masked:nth-of-type(1)');
const hoverFilter = await page.$$eval('.sb-masked', (els) => getComputedStyle(els[1]).filter);
check('google: hover does not reveal by default', /blur\(/.test(hoverFilter), hoverFilter);

// MutationObserver / infinite scroll
await page.evaluate(() => {
  const div = document.createElement('div');
  div.className = 'g';
  div.innerHTML = '<h3>Liverpool vs Everton 4-2 | Extended Highlights</h3>';
  document.getElementById('center_col').appendChild(div);
});
await page.waitForTimeout(600);
found = await masks(page);
check('google: dynamically added result gets masked (observer)',
  found.some((t) => t.trim() === '4-2'), JSON.stringify(found));

// popup count message path
const count = await worker.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => t.url && t.url.includes('google.html'));
  return await chrome.tabs.sendMessage(tab.id, { type: 'SB_GET_COUNT' });
});
check('google: content script reports a live count', count && count.count > 0, JSON.stringify(count));

// ---- toggle OFF ------------------------------------------------------------
const originalText = await page.$eval('#center_col .g h3', (e) => e.textContent);
await setSettings({ enabled: false });
await page.waitForTimeout(600);
const afterOff = await page.$$eval('.sb-masked, .sb-marker', (e) => e.length);
const restored = await page.$eval('#center_col .g h3', (e) => e.textContent);
check('toggle OFF: all masks and markers removed without reload', afterOff === 0, `${afterOff} left`);
check('toggle OFF: original text restored exactly',
  restored === 'Chelsea vs Arsenal 2-1 | Extended Highlights | Premier League', restored);

// fresh page while OFF => zero DOM changes
const offPage = await context.newPage();
await offPage.goto('http://localhost:' + PORT + '/google.html');
await offPage.waitForTimeout(900);
const offCount = await offPage.$$eval('.sb-masked', (e) => e.length);
check('toggle OFF: fresh page load makes no DOM changes at all', offCount === 0, `${offCount} masks`);
await offPage.close();

await setSettings({ enabled: true });
await page.waitForTimeout(700);
const backOn = await masks(page);
check('toggle ON again: masks reapplied without reload', backOn.length > 0, `${backOn.length} masks`);

// ---- YouTube fixture -------------------------------------------------------
const yt = await context.newPage();
await yt.goto('http://localhost:' + PORT + '/youtube.html');
await yt.waitForTimeout(1200);
const ytMasks = await masks(yt);
check('youtube: vs-pattern masks the score in a video title',
  ytMasks.some((t) => t.trim() === '2-1'), JSON.stringify(ytMasks));
check('youtube: no false positive on "10-12 minutes" recipe title',
  !ytMasks.some((t) => t.includes('10-12')), JSON.stringify(ytMasks));

const thumbs = await yt.$$eval('img.sb-thumb-blurred', (els) => els.length);
check('youtube: matching video thumbnail is blurred', thumbs === 1, `${thumbs} blurred thumbnails`);

const mastheadMasked = await yt.$$eval('#masthead .sb-masked', (e) => e.length);
check('youtube: masthead/chrome is skipped', mastheadMasked === 0, `${mastheadMasked} masks`);

const commentMasked = await yt.$$eval('ytd-comments .sb-masked', (e) => e.length);
check('youtube: comments skipped while "scan comments" is off', commentMasked === 0, `${commentMasked} masks`);

await setSettings({ rules: { numericKeyword: true, teamList: true, vsPattern: true, thumbnailBlur: true, scanComments: true } });
await yt.waitForTimeout(800);
const commentMasked2 = await yt.$$eval('ytd-comments .sb-masked', (e) => e.length);
check('youtube: comments scanned once the option is enabled', commentMasked2 > 0, `${commentMasked2} masks`);

// SPA navigation event
await yt.evaluate(() => {
  document.getElementById('contents').insertAdjacentHTML('beforeend',
    '<ytd-video-renderer><span id="video-title">Barcelona vs Real Madrid 3-3 | Highlights</span></ytd-video-renderer>');
  window.dispatchEvent(new CustomEvent('yt-navigate-finish'));
});
await yt.waitForTimeout(700);
const ytMasks2 = await masks(yt);
check('youtube: yt-navigate-finish triggers a rescan',
  ytMasks2.some((t) => t.trim() === '3-3'), JSON.stringify(ytMasks2));

// ---- rule toggles ----------------------------------------------------------
await setSettings({ rules: { numericKeyword: false, teamList: false, vsPattern: false, thumbnailBlur: false, scanComments: false } });
await yt.waitForTimeout(800);
const noRules = await masks(yt);
check('all rules off: nothing is masked', noRules.length === 0, JSON.stringify(noRules));

// ---- popup and options pages ----------------------------------------------
const extensionId = new URL(worker.url()).host;
await setSettings({ enabled: true });

const popupErrors = [];
const popup = await context.newPage();
popup.on('pageerror', (e) => popupErrors.push(String(e)));
await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
await popup.waitForTimeout(400);
check('popup: loads with no script errors', popupErrors.length === 0, popupErrors.join('; '));
check('popup: toggle reflects stored state', await popup.isChecked('#enabled'));
// The real input is visually hidden behind the styled track, as a user sees it.
await popup.click('.sb-toggle .sb-track');
await popup.waitForTimeout(400);
const storedAfterPopup = await worker.evaluate(
  () => new Promise((r) => chrome.storage.sync.get('enabled', (v) => r(v.enabled)))
);
check('popup: toggle writes to storage', storedAfterPopup === false, String(storedAfterPopup));
await popup.click('.sb-toggle .sb-track');
await popup.waitForTimeout(300);
await popup.close();

const optionErrors = [];
const options = await context.newPage();
options.on('pageerror', (e) => optionErrors.push(String(e)));
await options.goto(`chrome-extension://${extensionId}/options/options.html`);
await options.waitForTimeout(400);
check('options: loads with no script errors', optionErrors.length === 0, optionErrors.join('; '));
const teamText = await options.inputValue('#teams');
check('options: team list is populated from settings', teamText.includes('Chelsea'));

await options.fill('#keywordWindow', '25');
await options.fill('#keywords', 'highlights\nfull time');
await options.click('#save');
await options.waitForTimeout(500);
const savedSettings = await worker.evaluate(
  () => new Promise((r) => chrome.storage.sync.get(null, r))
);
check('options: save writes tuning back to storage',
  savedSettings.keywordWindow === 25 && savedSettings.keywords.length === 2,
  JSON.stringify({ w: savedSettings.keywordWindow, k: savedSettings.keywords }));

await options.fill('#site-input', 'not-a-pattern');
await options.click('#site-form button[type="submit"]');
await options.waitForTimeout(300);
const statusText = await options.textContent('#status');
check('options: rejects an invalid site match pattern',
  /match pattern/i.test(statusText || ''), String(statusText));
await options.close();

await context.close();
server.close();
fs.rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
