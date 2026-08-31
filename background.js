/**
 * Score Blocker service worker.
 *
 * Owns three small jobs: seeding default settings, keeping the toolbar badge in
 * sync with the on/off state, and registering content scripts for any extra
 * sites the user has granted access to from the options page.
 */
importScripts('common/defaults.js');

const DYNAMIC_SCRIPT_ID = 'sb-dynamic-sites';
const PREBLUR_SCRIPT_ID = 'sb-preblur';
const LOCKDOWN_SCRIPT_ID = 'sb-lockdown';
const TITLEGUARD_SCRIPT_ID = 'sb-titleguard';

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (stored) => resolve(sbMergeSettings(stored)));
  });
}

async function updateBadge(settings) {
  const cfg = settings || (await getSettings());
  await chrome.action.setBadgeText({ text: cfg.enabled ? 'ON' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: cfg.enabled ? '#1a7f37' : '#8b949e' });
  await chrome.action.setTitle({
    title: cfg.enabled ? 'Score Blocker: ON' : 'Score Blocker: OFF'
  });
}

async function grantedSites(sites) {
  const granted = [];
  for (const site of sites) {
    if (SB_BUILTIN_SITES.includes(site)) continue; // Already in the manifest.
    try {
      const has = await chrome.permissions.contains({ origins: [site] });
      if (has) granted.push(site);
    } catch (err) {
      // Not a valid match pattern for a permission — skip it.
    }
  }
  return granted;
}

/** Register/refresh the content script for user-added sites. */
async function syncDynamicScripts() {
  const settings = await getSettings();
  const matches = await grantedSites(settings.sites);

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [DYNAMIC_SCRIPT_ID]
    });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    }
  } catch (err) {
    // Nothing registered yet.
  }

  if (!matches.length) return;
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: DYNAMIC_SCRIPT_ID,
        matches,
        js: ['common/defaults.js', 'content/content.js'],
        css: ['content/content.css'],
        runAt: 'document_idle',
        persistAcrossSessions: true
      }
    ]);
  } catch (err) {
    console.warn('Score Blocker: could not register content scripts for', matches, err);
  }
}

/**
 * Register the document_start stylesheets that have to beat the first paint.
 *
 * Neither can be declared in the manifest: manifest CSS is injected
 * unconditionally, which would blur pages with the extension switched off, or
 * with Match Day off. Registering them only while their setting is on keeps
 * "off" meaning no page changes at all.
 *
 *   sb-preblur     brief blur released once the scan finishes
 *   sb-lockdown    Match Day blur of every description, held until it ends
 *   sb-titleguard  masks a score in the tab title before content.js can run
 *
 * The title guard acts without reading settings first, which is only safe
 * because it is registered exclusively while those settings say it should run.
 */
async function syncRegisteredStyles() {
  const settings = await getSettings();

  const wanted = [];
  if (settings.enabled && settings.preBlur) {
    wanted.push({
      id: PREBLUR_SCRIPT_ID,
      matches: SB_BUILTIN_SITES,
      css: ['content/preblur.css'],
      runAt: 'document_start',
      persistAcrossSessions: true
    });
  }
  if (settings.enabled && settings.matchDay && settings.strict.blurDescriptions) {
    wanted.push({
      id: LOCKDOWN_SCRIPT_ID,
      matches: SB_BUILTIN_SITES,
      css: ['content/lockdown.css'],
      runAt: 'document_start',
      persistAcrossSessions: true
    });
  }
  if (settings.enabled && (settings.maskTabTitle || settings.matchDay)) {
    // Extra sites the user has granted get the guard too - a club site putting
    // the score in its tab title is exactly the case it exists for.
    const granted = await grantedSites(settings.sites);
    wanted.push({
      id: TITLEGUARD_SCRIPT_ID,
      matches: SB_BUILTIN_SITES.concat(granted),
      js: ['content/titleguard.js'],
      runAt: 'document_start',
      persistAcrossSessions: true
    });
  }

  const ids = [PREBLUR_SCRIPT_ID, LOCKDOWN_SCRIPT_ID, TITLEGUARD_SCRIPT_ID];
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
    const stale = existing.map((script) => script.id);
    if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  } catch (err) {
    // Nothing registered yet.
  }

  if (!wanted.length) return;
  try {
    await chrome.scripting.registerContentScripts(wanted);
  } catch (err) {
    console.warn('Score Blocker: could not register document_start styles', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await new Promise((resolve) => chrome.storage.sync.get(null, resolve));
  const merged = sbMergeSettings(stored);
  // Seed only the keys that are missing. Writing the whole object back would
  // reset tuning on update, and would clobber any write racing with this one.
  const missing = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in stored)) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
  await updateBadge(merged);
  await syncDynamicScripts();
  await syncRegisteredStyles();
});

chrome.runtime.onStartup.addListener(async () => {
  await updateBadge();
  await syncDynamicScripts();
  await syncRegisteredStyles();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if (changes.enabled) await updateBadge();
  if (changes.sites) await syncDynamicScripts();
  if (
    changes.enabled ||
    changes.preBlur ||
    changes.matchDay ||
    changes.strict ||
    changes.maskTabTitle ||
    changes.sites
  ) {
    await syncRegisteredStyles();
  }
});

chrome.permissions.onAdded.addListener(() => {
  syncDynamicScripts();
  syncRegisteredStyles();
});
chrome.permissions.onRemoved.addListener(() => {
  syncDynamicScripts();
  syncRegisteredStyles();
});

// The popup owns the toggle UI, but keep a keyboard/command-free fallback:
// if the popup ever fails to open, clicking the icon still flips the switch.
chrome.action.onClicked.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.sync.set({ enabled: !settings.enabled });
});

updateBadge();
syncRegisteredStyles();
