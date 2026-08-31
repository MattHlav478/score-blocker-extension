/**
 * Pre-blur tests: the score must never be readable in a painted frame.
 *
 * content.js cannot run before the page paints, so a score is briefly visible
 * unless CSS blurs it at document_start. These tests sample every animation
 * frame and assert no frame ever showed a readable score.
 *
 * Run with: node test/preblur.mjs
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
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'score-blocker-preblur-'));
const PORT = 8866;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// A fixture whose subresources hold the load event open, like a real page.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const delay = Number(url.searchParams.get('ms') || 0);
  if (url.pathname === '/slow-image') {
    return setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    }, delay);
  }
  if (url.pathname === '/slow-script') {
    return setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('//');
    }, delay);
  }
  fs.readFile(path.join(TEST_DIR, 'fixtures', 'slow.html'), (e, d) => {
    res.writeHead(e ? 404 : 200, { 'Content-Type': 'text/html' });
    res.end(d || 'not found');
  });
});
await new Promise((r) => server.listen(PORT, r));

/** Copy the extension, pointing every match pattern at the local fixture. */
function buildExtension(label) {
  const ext = path.join(WORK, `ext-${label}`);
  fs.rmSync(ext, { recursive: true, force: true });
  fs.cpSync(SRC, ext, { recursive: true, filter: (s) => !s.includes('/.git') });

  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches = ['http://localhost/*'];
  manifest.host_permissions = ['http://localhost/*'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // The worker registers pre-blur for the built-in sites; retarget those too.
  const defaultsPath = path.join(ext, 'common', 'defaults.js');
  fs.writeFileSync(
    defaultsPath,
    fs
      .readFileSync(defaultsPath, 'utf8')
      .replace(
        "['https://www.google.com/*', 'https://www.youtube.com/*']",
        "['http://localhost/*']"
      )
  );
  return ext;
}

async function launch(label) {
  const ext = buildExtension(label);
  const context = await chromium.launchPersistentContext(path.join(WORK, `profile-${label}`), {
    headless: false,
    args: [
      '--headless=new',
      '--no-sandbox',
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`
    ]
  });
  const worker =
    context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  // onInstalled seeds defaults asynchronously; overriding before it lands would
  // race with that write.
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
  return { context, worker };
}

/** Load the fixture, sampling every frame for a readable score. */
async function sampleFrames(context, loads = 4) {
  let spoiled = 0;
  let frames = 0;
  let controlSharp = false;
  for (let i = 0; i < loads; i++) {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__spoiled = 0;
      window.__frames = 0;
      window.__done = false;
      const tick = () => {
        const h3 = document.querySelector('#score-result');
        if (h3) {
          window.__frames++;
          const masked = h3.querySelector('.sb-masked');
          const blurred = getComputedStyle(h3).filter.includes('blur');
          // A frame is "spoiled" if the score text is painted unmasked and unblurred.
          if (!masked && !blurred) window.__spoiled++;
          if (masked) {
            window.__done = true;
            return;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.__done || performance.now() > 4000, null, {
      timeout: 8000
    });
    const sample = await page.evaluate(() => ({
      spoiled: window.__spoiled,
      frames: window.__frames
    }));
    spoiled += sample.spoiled;
    frames += sample.frames;
    // A result with no score must end up sharp again once the scan releases.
    await page.waitForTimeout(300);
    controlSharp = await page.$eval('#control-result', (e) => {
      const f = getComputedStyle(e).filter;
      return f === 'none' || f === 'blur(0px)';
    });
    await page.close();
  }
  return { spoiled, frames, controlSharp };
}

// ---- 1. pre-blur on (the default) -----------------------------------------
{
  const { context } = await launch('on');
  const { spoiled, frames, controlSharp } = await sampleFrames(context);
  check('pre-blur on: the score is never readable in any painted frame',
    spoiled === 0 && frames > 0, `${spoiled} readable frames of ${frames} sampled`);
  check('pre-blur on: a result with no score is sharp again after the scan', controlSharp);
  await context.close();
}

// ---- 2. pre-blur off: proves the probe above can actually detect a flash ---
{
  const { context, worker } = await launch('off');
  await worker.evaluate(() => new Promise((r) => chrome.storage.sync.set({ preBlur: false }, r)));
  await new Promise((r) => setTimeout(r, 700));
  const { spoiled } = await sampleFrames(context, 2);
  check('pre-blur off: the score is readable, confirming the probe works',
    spoiled > 0, `${spoiled} readable frames`);
  await context.close();
}

// ---- 3. extension disabled: nothing is injected at all ---------------------
{
  const { context, worker } = await launch('disabled');
  await worker.evaluate(() => new Promise((r) => chrome.storage.sync.set({ enabled: false }, r)));
  await new Promise((r) => setTimeout(r, 700));

  const registered = await worker.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id))
  );
  check('disabled: the pre-blur stylesheet is unregistered',
    !registered.includes('sb-preblur'), JSON.stringify(registered));

  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => ({
    blurred: getComputedStyle(document.querySelector('#score-result')).filter,
    scannedClass: document.documentElement.className,
    masks: document.querySelectorAll('.sb-masked, .sb-marker').length
  }));
  check('disabled: no blur, no masks, no class on <html>',
    state.blurred === 'none' && state.masks === 0 && !state.scannedClass.includes('sb-scanned'),
    JSON.stringify(state));
  await context.close();
}

// ---- 4. Match Day descriptions are never painted readable ------------------
{
  const { context, worker } = await launch('matchday');
  await worker.evaluate(() => new Promise((r) => chrome.storage.sync.set({ matchDay: true }, r)));
  await new Promise((r) => setTimeout(r, 900));

  let spoiled = 0;
  let frames = 0;
  for (let i = 0; i < 3; i++) {
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__spoiled = 0;
      window.__frames = 0;
      const tick = () => {
        const desc = document.querySelector('#center_col .VwiC3b');
        if (desc) {
          window.__frames++;
          if (!getComputedStyle(desc).filter.includes('blur')) window.__spoiled++;
        }
        if (performance.now() < 3000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => performance.now() > 2000, null, { timeout: 8000 });
    const sample = await page.evaluate(() => ({ spoiled: window.__spoiled, frames: window.__frames }));
    spoiled += sample.spoiled;
    frames += sample.frames;
    await page.close();
  }
  check('match day: a description is never readable in any painted frame',
    spoiled === 0 && frames > 0, `${spoiled} readable frames of ${frames} sampled`);
  await context.close();
}

// ---- 5. the deadman switch in the stylesheet -------------------------------
{
  const { context } = await launch('deadman');
  const page = await context.newPage();
  // Apply the stylesheet to a bare page where no content script will ever run,
  // standing in for content.js failing to load.
  const css = fs.readFileSync(path.join(SRC, 'content', 'preblur.css'), 'utf8');
  await page.setContent(
    `<style>${css}</style><div id="center_col"><h3 id="score-result">Chelsea 2-1 Arsenal</h3></div>`
  );
  await page.waitForTimeout(200);
  const during = await page.$eval('#score-result', (e) => getComputedStyle(e).filter);
  check('fail-safe: the stylesheet blurs on its own', during.includes('blur'), during);
  await page.waitForTimeout(3400);
  const after = await page.$eval('#score-result', (e) => getComputedStyle(e).filter);
  check('fail-safe: the blur lifts after 3s even with no script running',
    after === 'none' || after === 'blur(0px)', after);
  await context.close();
}

server.close();
fs.rmSync(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
