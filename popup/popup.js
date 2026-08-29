/** Popup: the on/off toggle plus a live count from the active tab. */
(() => {
  'use strict';

  const enabledInput = document.getElementById('enabled');
  const stateLabel = document.getElementById('state');
  const countEl = document.getElementById('count');
  const countLabel = document.getElementById('count-label');

  let activeTabId = null;

  function renderState(enabled) {
    enabledInput.checked = enabled;
    stateLabel.textContent = enabled ? 'ON' : 'OFF';
    stateLabel.classList.toggle('on', enabled);
  }

  function renderCount(count) {
    countEl.textContent = String(count);
    countLabel.textContent = count === 1 ? 'score hidden on this page' : 'scores hidden on this page';
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
    renderState(sbMergeSettings(stored).enabled);
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

  document.getElementById('options').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
