/**
 * Tab-title guard, injected at document_start.
 *
 * content.js runs at document_end, by which point the <title> has been parsed
 * and shown in the tab strip for a few hundred milliseconds - measured at ~409ms
 * on a page with ordinary subresources. That is long enough to read a score.
 *
 * This file closes that window. It is registered by the service worker ONLY
 * while the extension is enabled and tab-title masking is on, so its presence
 * is already the permission to act: it does not wait for an async settings read
 * before masking, which is what makes it fast enough to matter.
 *
 * It therefore cannot see the user's own keyword and team lists. It uses a
 * deliberately conservative built-in rule instead - a score pair AND a sports
 * word in the same title - and hands the true original title to content.js,
 * which re-derives the mask from the user's real settings and corrects this
 * one. Over-masking for 400ms is cheap; under-masking is the whole problem.
 */
(() => {
  'use strict';

  if (window.__sbTitleGuard) return;

  const PLACEHOLDER = '•••';
  const NUM_PAIR = /\b\d{1,2}\s*[-–—:]\s*\d{1,2}\b/g;
  /** Conservative: a bare number pair in a title is far more often not a score. */
  const SPORTS_WORD =
    /(?:^|[^\w])(?:final score|full[- ]time|half[- ]time|ft|ht|highlights|extended highlights|recap|match report|results?|full match|vs\.?|v\.?|beat|beats|defeat|win|wins|won|draw|aggregate|penalties)(?:[^\w]|$)/i;

  const state = {
    /** The title as the page last set it, before any masking. */
    original: null,
    /** The masked title this guard wrote, so its own write is recognisable. */
    applied: null,
    stop
  };
  window.__sbTitleGuard = state;

  let observer = null;
  let timer = null;

  function maskTitle(title) {
    if (!title || !SPORTS_WORD.test(title)) return title;
    NUM_PAIR.lastIndex = 0;
    return title.replace(NUM_PAIR, PLACEHOLDER);
  }

  function apply() {
    const current = document.title;
    if (!current || current === state.applied) return;
    const masked = maskTitle(current);
    if (masked === current) return;
    state.original = current;
    state.applied = masked;
    document.title = masked;
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  apply(); // <title> may already be parsed.

  // At document_start it usually is not, so watch for it arriving.
  observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // content.js takes over at document_end and calls stop(). This is only a
  // backstop for the case where it never loads, so the guard does not observe
  // every mutation on the page for the rest of the session.
  timer = setTimeout(stop, 10000);
})();
