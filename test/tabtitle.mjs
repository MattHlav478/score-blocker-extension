/**
 * Tab title masking and blur-all-videos.
 *
 * The scenario both features exist for: a club's own site, where the score is
 * in the tab title and burned into a video's poster frame, with no result text
 * on the page to scan.
 *
 * Run with: node test/tabtitle.mjs
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'score-blocker-title-'));
const PORT = 8833;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const server = http.createServer((req, res) => {
  const name = req.url.split('?')[0].replace(/^\//, '') || 'clubsite.html';
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
const dPath = path.join(ext, 'common', 'defaults.js');
fs.writeFileSync(
  dPath,
  fs.readFileSync(dPath, 'utf8')
    .replace("['https://www.google.com/*', 'https://www.youtube.com/*']", "['http://localhost/*']")
);

const context = await chromium.launchPersistentContext(path.join(WORK, 'profile'), {
  headless: false,
  args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
const worker =
  context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
await worker.evaluate(
  () => new Promise((resolve) => {
    const poll = () =>
      chrome.storage.sync.get('enabled', (v) => (v.enabled === undefined ? setTimeout(poll, 25) : resolve()));
    poll();
  })
);
const setSettings = (patch) =>
  worker.evaluate((p) => new Promise((r) => chrome.storage.sync.set(p, r)), patch);
const registeredIds = () =>
  worker.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id).sort())
  );

const ORIGINAL_TITLE = 'Chelsea 2-1 Arsenal | Extended Highlights | Official Site';

// ---- tab title, on by default ---------------------------------------------
const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/clubsite.html`);
await page.waitForTimeout(1000);

let title = await page.title();
check('title: the score is masked', !title.includes('2-1') && title.includes('•••'), title);
check('title: the rest of the title survives, so the tab stays identifiable',
  title.includes('Chelsea') && title.includes('Arsenal') && title.includes('Extended Highlights'), title);

// ---- a clean title must be left completely alone --------------------------
await page.evaluate(() => { document.title = 'Match Centre | Official Site'; });
await page.waitForTimeout(400);
check('title: a title with no score is left untouched',
  (await page.title()) === 'Match Centre | Official Site', await page.title());

// A site rewriting its own title with a score is caught by the title observer.
await page.evaluate((t) => { document.title = t; }, ORIGINAL_TITLE);
await page.waitForTimeout(400);
title = await page.title();
check('title: a title the page rewrites later is masked too',
  !title.includes('2-1') && title.includes('•••'), title);

// ---- the document_start guard: no flash at all ----------------------------
{
  const probe = await context.newPage();
  await probe.addInitScript(() => {
    window.__spoiledFrames = 0;
    window.__frames = 0;
    const tick = () => {
      const t = document.title || '';
      if (t) {
        window.__frames++;
        if (t.includes('2-1')) window.__spoiledFrames++;
      }
      if (performance.now() < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await probe.goto(`http://localhost:${PORT}/clubsite.html`);
  await probe.waitForFunction(() => performance.now() > 2000, null, { timeout: 8000 });
  const seen = await probe.evaluate(() => ({ spoiled: window.__spoiledFrames, frames: window.__frames }));
  check('guard: the score is never visible in the tab title, in any frame',
    seen.spoiled === 0 && seen.frames > 0, `${seen.spoiled} spoiled of ${seen.frames} frames`);
  await probe.close();
}

check('guard: registered while title masking is on',
  (await registeredIds()).includes('sb-titleguard'), JSON.stringify(await registeredIds()));

// ---- the guard is coarse; the full settings must correct it ---------------
{
  // With every detection rule off, nothing should stay masked - which means
  // content.js has to undo the guard's cautious mask, not just leave it.
  await setSettings({
    rules: { numericKeyword: false, teamList: false, vsPattern: false, thumbnailBlur: false, scanComments: false }
  });
  const corrected = await context.newPage();
  await corrected.goto(`http://localhost:${PORT}/clubsite.html`);
  await corrected.waitForTimeout(1200);
  check('guard: a mask the real settings disagree with is undone',
    (await corrected.title()) === ORIGINAL_TITLE, await corrected.title());
  await corrected.close();
  await setSettings({
    rules: { numericKeyword: true, teamList: true, vsPattern: true, thumbnailBlur: true, scanComments: false }
  });
}

await setSettings({ maskTabTitle: false });
await page.waitForTimeout(700);
check('guard: unregistered when title masking is switched off',
  !(await registeredIds()).includes('sb-titleguard'), JSON.stringify(await registeredIds()));
await setSettings({ maskTabTitle: true });
await page.waitForTimeout(700);

// ---- videos: off by default -----------------------------------------------
check('videos: not blurred while the option is off',
  (await page.$$eval('.sb-video-blurred', (e) => e.length)) === 0);

// ---- videos: on ------------------------------------------------------------
await setSettings({ blurVideos: true });
await page.waitForTimeout(800);
const state = await page.evaluate(() => ({
  video: document.getElementById('main-video').classList.contains('sb-video-blurred'),
  embed: document.getElementById('yt-embed').classList.contains('sb-video-blurred'),
  logo: document.getElementById('sponsor-logo').classList.contains('sb-video-blurred'),
  pixel: document.getElementById('tracking-pixel').classList.contains('sb-video-blurred')
}));
check('videos: the player and its poster frame are blurred', state.video, JSON.stringify(state));
check('videos: the iframe embed is blurred', state.embed, JSON.stringify(state));
check('videos: a small logo is not treated as a video', !state.logo, JSON.stringify(state));
check('videos: a 1x1 tracking iframe is skipped', !state.pixel, JSON.stringify(state));

const filter = await page.$eval('#main-video', (e) => getComputedStyle(e).filter);
check('videos: the blur is actually applied', filter.includes('blur'), filter);

// Click to reveal.
await page.click('#main-video');
await page.waitForTimeout(350);
check('videos: clicking reveals the player',
  (await page.$eval('#main-video', (e) => getComputedStyle(e).filter)) === 'none');

// Playing reveals, since watching a blurred video is pointless.
await page.evaluate(() => {
  const v = document.getElementById('main-video');
  v.classList.remove('sb-revealed');
  v.dispatchEvent(new Event('play', { bubbles: false }));
});
await page.waitForTimeout(300);
check('videos: playing one reveals it',
  await page.$eval('#main-video', (e) => e.classList.contains('sb-revealed')));

// ---- Match Day forces videos on even with the option off ------------------
await setSettings({ blurVideos: false, matchDay: true });
const md = await context.newPage();
await md.goto(`http://localhost:${PORT}/clubsite.html`);
await md.waitForTimeout(1000);
check('videos: Match Day blurs them even with the option off',
  await md.$eval('#main-video', (e) => e.classList.contains('sb-video-blurred')));
await md.close();
await setSettings({ matchDay: false });

// ---- switching off restores everything ------------------------------------
await setSettings({ enabled: false });
await page.waitForTimeout(900);
const after = await page.evaluate(() => ({
  title: document.title,
  videos: document.querySelectorAll('.sb-video-blurred').length
}));
check('off: the original tab title is restored exactly',
  after.title === 'Chelsea 2-1 Arsenal | Extended Highlights | Official Site', after.title);
check('off: no video is left blurred', after.videos === 0, String(after.videos));

// ---- the page changing its title while masked must not be clobbered -------
await setSettings({ enabled: true });
await page.waitForTimeout(700);
await page.evaluate(() => { document.title = 'Something else entirely'; });
await page.waitForTimeout(400);
await setSettings({ enabled: false });
await page.waitForTimeout(700);
check('off: a title the page changed since masking is not clobbered',
  (await page.title()) === 'Something else entirely', await page.title());

await context.close();
server.close();
fs.rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
