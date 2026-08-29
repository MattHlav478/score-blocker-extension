/**
 * Score Blocker service worker.
 *
 * Owns three small jobs: seeding default settings, keeping the toolbar badge in
 * sync with the on/off state, and registering content scripts for any extra
 * sites the user has granted access to from the options page.
 */
importScripts('common/defaults.js');

const DYNAMIC_SCRIPT_ID = 'sb-dynamic-sites';

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

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await new Promise((resolve) => chrome.storage.sync.get(null, resolve));
  // Only write keys that are missing, so an update never resets tuning.
  const merged = sbMergeSettings(stored);
  await chrome.storage.sync.set(merged);
  await updateBadge(merged);
  await syncDynamicScripts();
});

chrome.runtime.onStartup.addListener(async () => {
  await updateBadge();
  await syncDynamicScripts();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if (changes.enabled) await updateBadge();
  if (changes.sites) await syncDynamicScripts();
});

chrome.permissions.onAdded.addListener(() => syncDynamicScripts());
chrome.permissions.onRemoved.addListener(() => syncDynamicScripts());

// The popup owns the toggle UI, but keep a keyboard/command-free fallback:
// if the popup ever fails to open, clicking the icon still flips the switch.
chrome.action.onClicked.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.sync.set({ enabled: !settings.enabled });
});

updateBadge();
