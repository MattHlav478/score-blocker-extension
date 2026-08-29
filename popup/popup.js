/** Popup: the on/off toggle plus a live count from the active tab. */
(() => {
  'use strict';

  const enabledInput = document.getElementById('enabled');
  const matchDayInput = document.getElementById('matchDay');
  const matchDayRow = document.getElementById('match-day-row');
  const matchNote = document.getElementById('match-note');
  const stateLabel = document.getElementById('state');
  const countEl = document.getElementById('count');
  const countLabel = document.getElementById('count-label');

  let activeTabId = null;

  function renderState(enabled) {
    enabledInput.checked = enabled;
    stateLabel.textContent = enabled ? 'ON' : 'OFF';
    stateLabel.classList.toggle('on', enabled);
    // Match Day is meaningless while the extension itself is off.
    matchDayInput.disabled = !enabled;
    matchDayRow.setAttribute('aria-disabled', String(!enabled));
    renderMatchDay(matchDayInput.checked && enabled);
  }

  function renderMatchDay(on) {
    matchDayInput.checked = on;
    matchNote.hidden = !on;
  }

  function renderCount(count) {
    countEl.textContent = String(count);
    // Match Day hides whole blocks as well as scores, so "scores" would undercount.
    const noun = matchDayInput.checked ? 'item' : 'score';
    countLabel.textContent = `${noun}${count === 1 ? '' : 's'} hidden on this page`;
  }

  function requestCount() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id === undefined) return renderCount(0);
      activeTabId = tab.id;
      chrome.tabs.sendMessage(tab.id, { type: 'SB_GET_COUNT' }, (response) => {
        if (chrome.runtime.lastError || !response) return renderCount(0);
        renderCount(response.count || 0);
      });
    });
  }

  chrome.storage.sync.get(null, (stored) => {
    const settings = sbMergeSettings(stored);
    renderMatchDay(settings.matchDay);
    renderState(settings.enabled);
    requestCount();
  });

  enabledInput.addEventListener('change', () => {
    const enabled = enabledInput.checked;
    renderState(enabled);
    chrome.storage.sync.set({ enabled }, () => {
      // Give the content script a moment to mask or unmask, then refresh.
      setTimeout(requestCount, 250);
    });
  });

  // Content scripts push a fresh count after each scan.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== 'SB_COUNT') return;
    // Ignore scans happening in other tabs.
    if (activeTabId !== null && sender.tab && sender.tab.id !== activeTabId) return;
    renderCount(message.count || 0);
  });

  matchDayInput.addEventListener('change', () => {
    const matchDay = matchDayInput.checked;
    renderMatchDay(matchDay);
    chrome.storage.sync.set({ matchDay }, () => setTimeout(requestCount, 250));
  });

  document.getElementById('options').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
