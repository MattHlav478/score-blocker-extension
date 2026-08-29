/** Options page: rule toggles, word lists, and runtime site permissions. */
(() => {
  'use strict';

  const RULE_IDS = [
    'numericKeyword',
    'teamList',
    'vsPattern',
    'thumbnailBlur',
    'scanComments'
  ];

  const el = (id) => document.getElementById(id);
  const statusEl = el('status');
  let sites = [];

  function parseList(text) {
    return text
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', Boolean(isError));
    if (message) setTimeout(() => setStatus(''), 2500);
  }

  /** Only https/http origin patterns are accepted, e.g. https://example.com/*  */
  function isValidPattern(pattern) {
    return /^https?:\/\/(\*\.)?[^/*\s]+\/\*?.*$/.test(pattern);
  }

  async function renderSites() {
    const list = el('site-list');
    list.textContent = '';
    for (const site of sites) {
      let granted = false;
      try {
        granted = await chrome.permissions.contains({ origins: [site] });
      } catch (err) {
        granted = false;
      }

      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = site;
      const tag = document.createElement('span');
      tag.className = granted ? 'tag granted' : 'tag';
      tag.textContent = granted ? 'access granted' : 'access not granted';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => removeSite(site));

      const right = document.createElement('span');
      right.append(tag, ' ', remove);
      li.append(label, right);
      list.appendChild(li);
    }
  }

  async function addSite(pattern) {
    if (!isValidPattern(pattern)) {
      setStatus('Use a match pattern like https://www.reddit.com/*', true);
      return;
    }
    if (SB_BUILTIN_SITES.includes(pattern)) {
      setStatus('That site is already built in.', true);
      return;
    }
    if (sites.includes(pattern)) {
      setStatus('Already in the list.', true);
      return;
    }

    let granted = false;
    try {
      // Must be called straight from the click for Chrome to show the prompt.
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (err) {
      setStatus('Chrome rejected that pattern.', true);
      return;
    }
    if (!granted) {
      setStatus('Permission denied — site not added.', true);
      return;
    }

    sites.push(pattern);
    await chrome.storage.sync.set({ sites });
    await renderSites();
    setStatus('Site added.');
  }

  async function removeSite(pattern) {
    sites = sites.filter((s) => s !== pattern);
    await chrome.storage.sync.set({ sites });
    try {
      await chrome.permissions.remove({ origins: [pattern] });
    } catch (err) {
      // Permission may already be gone.
    }
    await renderSites();
    setStatus('Site removed.');
  }

  function render(settings) {
    el('enabled').checked = settings.enabled;
    el('revealOnHover').checked = settings.revealOnHover;
    el('preBlur').checked = settings.preBlur;
    el('keywordWindow').value = settings.keywordWindow;
    for (const rule of RULE_IDS) {
      el(`rule-${rule}`).checked = Boolean(settings.rules[rule]);
    }
    el('teams').value = settings.teams.join('\n');
    el('keywords').value = settings.keywords.join('\n');
    sites = settings.sites.slice();
    renderSites();
  }

  function collect() {
    const rules = {};
    for (const rule of RULE_IDS) rules[rule] = el(`rule-${rule}`).checked;
    return {
      enabled: el('enabled').checked,
      revealOnHover: el('revealOnHover').checked,
      preBlur: el('preBlur').checked,
      keywordWindow: Number(el('keywordWindow').value),
      rules,
      teams: parseList(el('teams').value),
      keywords: parseList(el('keywords').value),
      sites
    };
  }

  el('save').addEventListener('click', () => {
    const settings = sbMergeSettings(collect());
    chrome.storage.sync.set(settings, () => {
      if (chrome.runtime.lastError) setStatus(chrome.runtime.lastError.message, true);
      else setStatus('Saved.');
    });
  });

  el('site-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = el('site-input');
    addSite(input.value.trim()).then(() => {
      input.value = '';
    });
  });

  for (const button of document.querySelectorAll('[data-reset]')) {
    button.addEventListener('click', () => {
      const which = button.dataset.reset;
      const defaults = which === 'teams' ? SB_DEFAULT_TEAMS : SB_DEFAULT_KEYWORDS;
      el(which).value = defaults.join('\n');
      setStatus('Reset — press Save to apply.');
    });
  }

  chrome.storage.sync.get(null, (stored) => render(sbMergeSettings(stored)));
})();
