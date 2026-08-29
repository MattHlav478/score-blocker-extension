/**
 * Score Blocker content script.
 *
 * Scans text nodes for score-shaped text and wraps matches in a blurred span
 * that can be clicked to reveal. Does nothing at all while the extension is
 * toggled off: no scan, no observer, no DOM changes.
 */
(() => {
  'use strict';

  if (window.__scoreBlockerLoaded) return;
  window.__scoreBlockerLoaded = true;

  const MASK_CLASS = 'sb-masked';
  const REVEALED_CLASS = 'sb-revealed';
  const THUMB_CLASS = 'sb-thumb-blurred';
  const MARKER_CLASS = 'sb-marker';
  const SCANNED_CLASS = 'sb-scanned';
  const BLOCK_MASK_CLASS = 'sb-block-masked';
  /** Longest text a single result block is expected to hold. */
  const MAX_BLOCK_TEXT = 600;
  const HOVER_CLASS = 'sb-hover-reveal';
  const SCAN_DEBOUNCE_MS = 150;

  /** "2-1", "3 – 0", "1:1". */
  const NUM_PAIR = /\b\d{1,2}\s*[-–—:]\s*\d{1,2}\b/g;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'CODE', 'PRE'
  ]);

  /** Tags that end a "context" — everything else is treated as inline. */
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'LI', 'TD', 'TH', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'ASIDE',
    'MAIN', 'HEADER', 'FOOTER', 'NAV', 'BLOCKQUOTE', 'FIGCAPTION', 'DD', 'DT',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BODY'
  ]);

  /** Chrome/navigation surfaces that never carry results worth scanning. */
  const ALWAYS_SKIP_SELECTOR = [
    '#masthead', '#masthead-container', 'ytd-guide-renderer',
    'tp-yt-app-drawer', 'ytd-mini-guide-renderer', 'ytd-player',
    '#movie_player', 'ytd-searchbox', '#searchform', 'header#gb', '#gb'
  ].join(',');

  const COMMENTS_SELECTOR = 'ytd-comments, #comments, ytd-comment-thread-renderer';

  /** Containers whose thumbnail we blur when their text matched. */
  const VIDEO_CONTAINER_SELECTOR = [
    'ytd-video-renderer', 'ytd-rich-item-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-video-renderer',
    'ytd-reel-item-renderer', 'ytd-radio-renderer', 'ytd-movie-renderer',
    'ytd-video-preview', 'yt-lockup-view-model',
    '.g', '.MjjYud', '.tF2Cxc', '[data-hveid]', 'article', 'li'
  ].join(',');

  let settings = null;
  let detector = null;
  let active = false;
  let observer = null;
  let scanTimer = null;
  let pendingRoots = new Set();
  let pendingFullScan = false;

  const processedNodes = new WeakSet();
  const maskedSpans = new Set();
  const maskedBlocks = new Set();
  const blurredThumbs = new Set();

  /** True when the aggressive Match Day layers should run. */
  function inMatchDay() {
    return Boolean(settings && settings.matchDay);
  }

  // ---------------------------------------------------------------- detection

  function escapeRe(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Precompile every regex we need for the current settings, so scanning never
   * pays for regex construction.
   */
  function buildDetector(cfg) {
    const keywords = cfg.keywords.map(escapeRe).filter(Boolean);
    const spoilers = cfg.spoilerKeywords.map(escapeRe).filter(Boolean);
    const teams = cfg.teams.map(escapeRe).filter(Boolean);
    const teamAlt = teams.length ? `(?:${teams.join('|')})` : null;

    return {
      teamAny: teamAlt ? new RegExp(teamAlt, 'i') : null,
      // Words that give a result away with no scoreline present. Match Day only.
      spoiler: spoilers.length
        ? new RegExp(`(?:^|[^\\w])(?:${spoilers.join('|')})(?:[^\\w]|$)`, 'i')
        : null,
      keyword: keywords.length
        ? new RegExp(`(?:^|[^\\w])(?:${keywords.join('|')})(?:[^\\w]|$)`, 'i')
        : null,
      // "Chelsea 2-1", "2-1 Arsenal" — one team name hugging a score pair.
      teamPair: teamAlt
        ? new RegExp(
            `${teamAlt}\\D{0,15}\\d{1,2}\\s*[-–—:]\\s*\\d{1,2}` +
              `|\\d{1,2}\\s*[-–—:]\\s*\\d{1,2}\\D{0,15}${teamAlt}`,
            'gi'
          )
        : null,
      // "Chelsea 2 1 Arsenal" — team, digits, team with no separator.
      teamSpread: teamAlt
        ? new RegExp(`${teamAlt}\\D{0,15}\\d{1,2}\\D{1,5}\\d{1,2}\\D{0,15}${teamAlt}`, 'gi')
        : null,
      // "Chelsea 3 Arsenal 0" — the team name itself sits between the scores,
      // which the gap above is deliberately too tight to span.
      teamSandwich: teamAlt
        ? new RegExp(
            `${teamAlt}\\D{0,15}\\d{1,2}\\D{0,15}${teamAlt}\\D{0,15}\\d{1,2}`,
            'gi'
          )
        : null,
      // "Team A vs Team B 2-1" and the reverse ordering.
      vsPair: new RegExp(
        `\\bvs\\.?\\b[\\s\\S]{0,30}?\\d{1,2}\\s*[-–—:]\\s*\\d{1,2}` +
          `|\\d{1,2}\\s*[-–—:]\\s*\\d{1,2}[\\s\\S]{0,30}?\\bvs\\.?\\b`,
        'gi'
      )
    };
  }

  /** True when `index` falls inside any match of `re` within `text`. */
  function indexInsideMatch(re, text, index) {
    if (!re) return false;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (index >= m.index && index < m.index + m[0].length) return true;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return false;
  }

  /**
   * Decide which slices of `text` should be masked.
   *
   * `context` is the surrounding block's full text and `offset` is where `text`
   * starts inside it, so keyword/team proximity is judged across element
   * boundaries (a title in one span, a score in the next).
   *
   * Returns an array of {start, end} ranges local to `text`.
   */
  function findMaskRanges(text, context, offset) {
    const ranges = [];
    const rules = settings.rules;
    const win = settings.keywordWindow;

    NUM_PAIR.lastIndex = 0;
    let match;
    while ((match = NUM_PAIR.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const contextIndex = offset + start;
      let hit = false;

      if (rules.numericKeyword && detector.keyword) {
        const from = Math.max(0, contextIndex - win);
        const to = Math.min(context.length, contextIndex + match[0].length + win);
        hit = detector.keyword.test(context.slice(from, to));
      }
      if (!hit && rules.teamList) {
        hit = indexInsideMatch(detector.teamPair, context, contextIndex);
      }
      if (!hit && rules.vsPattern) {
        hit = indexInsideMatch(detector.vsPair, context, contextIndex);
      }
      if (hit) ranges.push({ start, end });
    }

    // Scores written without a separator ("Chelsea 3 Arsenal 0") never form a
    // numeric pair, so the pass above cannot see them. Mask each number in the
    // match individually and leave the team names readable.
    if (rules.teamList) {
      for (const re of [detector.teamSpread, detector.teamSandwich]) {
        if (!re) continue;
        re.lastIndex = 0;
        let match2;
        while ((match2 = re.exec(text)) !== null) {
          const digits = /\d{1,2}/g;
          let digit;
          while ((digit = digits.exec(match2[0])) !== null) {
            ranges.push({
              start: match2.index + digit.index,
              end: match2.index + digit.index + digit[0].length
            });
          }
          if (match2.index === re.lastIndex) re.lastIndex++;
        }
      }
    }

    return mergeRanges(ranges);
  }

  function mergeRanges(ranges) {
    if (ranges.length < 2) return ranges;
    ranges.sort((a, b) => a.start - b.start);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      if (ranges[i].start <= last.end) {
        last.end = Math.max(last.end, ranges[i].end);
      } else {
        merged.push(ranges[i]);
      }
    }
    return merged;
  }

  // ------------------------------------------------------------------- masking

  function maskTextNode(node, ranges) {
    const text = node.nodeValue;
    const parent = node.parentNode;
    if (!parent) return 0;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let masked = 0;

    for (const range of ranges) {
      if (range.start > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, range.start)));
      }
      const original = text.slice(range.start, range.end);
      const span = document.createElement('span');
      span.className = MASK_CLASS;
      span.dataset.sbOriginal = original;
      span.textContent = original;
      span.title = 'Score Blocker: hidden — click to reveal';
      span.setAttribute('role', 'button');
      span.setAttribute('tabindex', '0');
      fragment.appendChild(span);

      // The marker sits outside the blurred span so it stays crisp — without
      // it a mask can read as a rendering glitch.
      const marker = document.createElement('span');
      marker.className = MARKER_CLASS;
      marker.textContent = '\u{1F6AB}';
      marker.setAttribute('aria-hidden', 'true');
      fragment.appendChild(marker);

      maskedSpans.add(span);
      processedNodes.add(span.firstChild);
      processedNodes.add(marker.firstChild);
      cursor = range.end;
      masked++;
    }
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    parent.replaceChild(fragment, node);
    return masked;
  }

  /**
   * Blur a whole element rather than a substring inside it.
   *
   * Used where masking one word would leak the rest of the sentence: "Chelsea
   * stun Arsenal" tells you everything even with "stun" hidden. Unlike
   * maskTextNode this performs no DOM surgery at all — it only adds a class —
   * so teardown cannot corrupt the page, which matters because Match Day gets
   * toggled on and off often.
   */
  function maskBlock(el, options) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return 0;
    if (el.classList.contains(BLOCK_MASK_CLASS)) return 0;
    // Never nest a block mask inside one that already covers this text.
    if (el.closest(`.${BLOCK_MASK_CLASS}`)) return 0;
    // A block far larger than one result is a container holding many of them.
    // Masking it would blur the whole page off a single spoiler word.
    const limit = options && options.maxText !== undefined ? options.maxText : MAX_BLOCK_TEXT;
    if ((el.textContent || '').length > limit) return 0;
    el.classList.add(BLOCK_MASK_CLASS);
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    if (!el.title) el.title = 'Score Blocker: hidden — click to reveal';
    maskedBlocks.add(el);
    return 1;
  }

  function unmaskBlocks() {
    for (const el of maskedBlocks) {
      el.classList.remove(BLOCK_MASK_CLASS, REVEALED_CLASS);
      el.removeAttribute('role');
      el.removeAttribute('tabindex');
      if (el.title && el.title.startsWith('Score Blocker')) el.removeAttribute('title');
    }
    maskedBlocks.clear();
    // Descriptions blurred by the document_start stylesheet are revealed by
    // class too; clear those so nothing stays stuck revealed or hidden.
    for (const el of document.querySelectorAll(`.${REVEALED_CLASS}`)) {
      if (!el.classList.contains(MASK_CLASS) && !el.classList.contains(THUMB_CLASS)) {
        el.classList.remove(REVEALED_CLASS);
      }
    }
  }

  function blurThumbnails(fromElement, force) {
    if (!fromElement) return;
    if (!force && !settings.rules.thumbnailBlur) return;
    const container = fromElement.closest(VIDEO_CONTAINER_SELECTOR);
    if (!container) return;
    const images = container.querySelectorAll('img, yt-image img, .sb-thumb-candidate');
    for (const img of images) {
      if (img.classList.contains(THUMB_CLASS)) continue;
      const box = img.getBoundingClientRect();
      // Skip avatars and icons; only cover things thumbnail-shaped.
      if (box.width && box.width < 60) continue;
      img.classList.add(THUMB_CLASS);
      img.title = 'Score Blocker: thumbnail hidden — click to reveal';
      blurredThumbs.add(img);
    }
  }

  function unmaskAll() {
    for (const span of maskedSpans) {
      const parent = span.parentNode;
      if (!parent) continue;
      const marker = span.nextSibling;
      if (marker && marker.nodeType === Node.ELEMENT_NODE && marker.classList.contains(MARKER_CLASS)) {
        parent.removeChild(marker);
      }
      parent.replaceChild(document.createTextNode(span.dataset.sbOriginal || span.textContent), span);
      parent.normalize();
    }
    maskedSpans.clear();
    unmaskBlocks();
    for (const img of blurredThumbs) {
      img.classList.remove(THUMB_CLASS, REVEALED_CLASS);
      if (img.title && img.title.startsWith('Score Blocker')) img.removeAttribute('title');
    }
    blurredThumbs.clear();
  }

  // ------------------------------------------------------------------ scanning

  function isSkippedElement(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    if (el.classList && (el.classList.contains(MASK_CLASS) || el.classList.contains(MARKER_CLASS))) {
      return true;
    }
    if (el.closest(ALWAYS_SKIP_SELECTOR)) return true;
    if (!settings.rules.scanComments && el.closest(COMMENTS_SELECTOR)) return true;
    return false;
  }

  function contextContainerOf(node) {
    let el = node.parentElement;
    while (el && el !== document.documentElement) {
      // Custom elements (ytd-*, yt-*) delimit a context just like block tags.
      if (BLOCK_TAGS.has(el.tagName) || el.tagName.includes('-')) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  let pageSportsCache = null;

  /**
   * Does the page as a whole look sports-related?
   *
   * Checked against the search query and document title, so on an obviously
   * sporting search every result qualifies even if an individual title is
   * neutral ("Extended Highlights" with no team named).
   */
  function pageLooksSportsRelated() {
    if (pageSportsCache !== null) return pageSportsCache;
    const params = new URLSearchParams(location.search);
    const haystack = `${params.get('q') || ''} ${params.get('search_query') || ''} ${document.title || ''}`;
    pageSportsCache = Boolean(
      (detector.teamAny && detector.teamAny.test(haystack)) ||
        (detector.keyword && detector.keyword.test(haystack))
    );
    return pageSportsCache;
  }

  /**
   * Does this individual result look sports-related?
   *
   * Gates thumbnail blurring in Match Day: descriptions are cheap to blur and
   * one click to read, but a page where every thumbnail is blurred cannot be
   * navigated at all, so images stay conditional.
   */
  function looksSportsRelated(container) {
    if (!container) return false;
    if (pageLooksSportsRelated()) return true;
    const text = container.textContent || '';
    if (!text) return false;
    return Boolean(
      (detector.teamAny && detector.teamAny.test(text)) ||
        (detector.keyword && detector.keyword.test(text)) ||
        (detector.spoiler && detector.spoiler.test(text))
    );
  }

  /**
   * The Match Day layers that are not driven by text-node scanning: the
   * comments section, and thumbnails on sports-looking results.
   */
  function applyMatchDayLayers(root) {
    if (!inMatchDay()) return 0;
    let masked = 0;

    if (settings.strict.blurComments) {
      for (const el of document.querySelectorAll(SB_COMMENTS_SELECTOR)) {
        // Deliberately unbounded: the whole section is meant to go at once.
        masked += maskBlock(el, { maxText: Infinity });
      }
    }

    if (settings.strict.thumbnails) {
      const scope = root && root.nodeType === Node.ELEMENT_NODE ? root : document.body;
      const containers = new Set(scope.querySelectorAll(VIDEO_CONTAINER_SELECTOR));
      if (scope.matches && scope.matches(VIDEO_CONTAINER_SELECTOR)) containers.add(scope);
      for (const container of containers) {
        if (looksSportsRelated(container)) blurThumbnails(container, true);
      }
    }
    return masked;
  }

  /** Root selection: on Google we only care about the results column. */
  function scanRootsFor(root) {
    if (root !== document.body && root !== document) return [root];
    if (location.hostname.endsWith('google.com')) {
      const column = document.querySelector('#center_col, #rso, #search, #main');
      if (column) return [column];
    }
    return [document.body];
  }

  function scanRoot(root) {
    if (!root || !root.isConnected) return 0;
    let element = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    if (!element) return 0;
    if (isSkippedElement(element)) return 0;

    // Outside Match Day only text containing a digit can possibly match, and
    // skipping the rest keeps the walk cheap. The spoiler-word rule has no such
    // guarantee, so the gate lifts while it is running.
    const wordScan = Boolean(
      inMatchDay() && settings.strict.spoilerWords && detector.spoiler
    );

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (processedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        const value = node.nodeValue;
        if (!value || value.length < 3) return NodeFilter.FILTER_REJECT;
        if (!wordScan && !/\d/.test(value)) return NodeFilter.FILTER_REJECT;
        // Whitespace between result blocks belongs to the container that wraps
        // all of them; accepting it would judge the whole column as one block.
        if (wordScan && !/[A-Za-z]/.test(value)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || isSkippedElement(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    // Group text nodes by their block container so proximity checks can see
    // text that lives in a sibling element.
    const groups = new Map();
    let node;
    while ((node = walker.nextNode()) !== null) {
      processedNodes.add(node);
      const container = contextContainerOf(node);
      let group = groups.get(container);
      if (!group) {
        group = { text: container.textContent || '', nodes: [] };
        groups.set(container, group);
      }
      group.nodes.push(node);
    }

    let masked = 0;
    for (const [container, group] of groups) {
      // A spoiler word masks the whole block: hiding just the word would leave
      // the rest of the sentence, which usually gives the result away anyway.
      if (wordScan && detector.spoiler.test(group.text)) {
        masked += maskBlock(container);
        if (settings.strict.thumbnails && looksSportsRelated(container)) {
          blurThumbnails(container, true);
        }
        continue;
      }

      let searchFrom = 0;
      for (const textNode of group.nodes) {
        if (!textNode.isConnected) continue;
        const value = textNode.nodeValue;
        // The container's textContent contains each node's text in order, so a
        // forward-only indexOf gives us each node's offset within the context.
        let offset = group.text.indexOf(value, searchFrom);
        if (offset === -1) offset = group.text.indexOf(value);
        if (offset === -1) offset = 0;
        else searchFrom = offset + value.length;

        const ranges = findMaskRanges(value, group.text, offset);
        if (!ranges.length) continue;
        const parent = textNode.parentElement;
        masked += maskTextNode(textNode, ranges);
        blurThumbnails(parent || container);
      }
    }
    return masked;
  }

  function runScan(roots) {
    if (!active) return;
    let masked = 0;
    for (const root of roots) {
      for (const target of scanRootsFor(root)) {
        masked += scanRoot(target);
      }
      masked += applyMatchDayLayers(root);
    }
    if (masked > 0) reportCount();
  }

  function scheduleScan(root) {
    if (!active) return;
    if (root) pendingRoots.add(root);
    else pendingFullScan = true;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const roots = pendingFullScan ? [document.body] : Array.from(pendingRoots);
      pendingRoots = new Set();
      pendingFullScan = false;
      runScan(roots.length ? roots : [document.body]);
    }, SCAN_DEBOUNCE_MS);
  }

  // ----------------------------------------------------------------- lifecycle

  function onMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        // Text swapped in place (YouTube reuses nodes across navigations).
        processedNodes.delete(mutation.target);
        scheduleScan(mutation.target.parentElement);
        continue;
      }
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.ELEMENT_NODE) {
          if (added.classList && added.classList.contains(MASK_CLASS)) continue;
          scheduleScan(added);
        } else if (added.nodeType === Node.TEXT_NODE && added.parentElement) {
          scheduleScan(added.parentElement);
        }
      }
    }
  }

  function onNavigate() {
    if (!active) return;
    pageSportsCache = null; // A new query may not be sports-related at all.
    pendingFullScan = true;
    scheduleScan(null);
  }

  /** The element a click should reveal, if any. */
  function revealTargetFor(target) {
    const span = target.closest(`.${MASK_CLASS}`);
    if (span) return span;
    const block = target.closest(`.${BLOCK_MASK_CLASS}`);
    if (block) return block;
    if (target.classList && target.classList.contains(THUMB_CLASS)) return target;
    // Descriptions blurred by the document_start stylesheet carry no class of
    // their own, so they are matched by the same selector list the CSS uses.
    if (inMatchDay() && settings.strict.blurDescriptions) {
      const description = target.closest(SB_DESCRIPTION_SELECTOR);
      if (description) return description;
    }
    return null;
  }

  function onClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const revealable = revealTargetFor(target);
    if (!revealable) return;
    event.preventDefault();
    event.stopPropagation();
    revealable.classList.toggle(REVEALED_CLASS);
  }

  function onKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.classList.contains(MASK_CLASS) && !target.classList.contains(BLOCK_MASK_CLASS)) {
      return;
    }
    event.preventDefault();
    target.classList.toggle(REVEALED_CLASS);
  }

  function start() {
    if (active) return;
    active = true;
    detector = buildDetector(settings);
    document.documentElement.classList.toggle(HOVER_CLASS, settings.revealOnHover);

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);

    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    runScan([document.body]);
    releasePreBlur();
    reportCount();
  }

  function stop() {
    if (!active) return;
    active = false;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    pendingRoots = new Set();
    pendingFullScan = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('yt-navigate-finish', onNavigate);
    window.removeEventListener('popstate', onNavigate);
    document.documentElement.classList.remove(HOVER_CLASS);
    unmaskAll();
    reportCount();
  }

  /** Re-run from scratch after a settings change while a tab is open. */
  function restart() {
    pageSportsCache = null;
    const wasActive = active;
    if (wasActive) stop();
    if (settings.enabled) start();
  }

  /**
   * Lift the document_start pre-blur now that the real masks are in place.
   *
   * Only touched when pre-blur is on, which is the same condition under which
   * the service worker injected the stylesheet — so a page that was never
   * pre-blurred is never modified.
   */
  function releasePreBlur() {
    if (!settings.preBlur) return;
    document.documentElement.classList.add(SCANNED_CLASS);
  }

  /** Masked scores plus whole blocks hidden by Match Day. */
  function hiddenCount() {
    return maskedSpans.size + maskedBlocks.size;
  }

  function reportCount() {
    try {
      chrome.runtime.sendMessage({ type: 'SB_COUNT', count: hiddenCount() }, () => {
        void chrome.runtime.lastError; // No popup listening is fine.
      });
    } catch (err) {
      // Extension context invalidated (reload/update); nothing to do.
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'SB_GET_COUNT') {
      sendResponse({ count: hiddenCount(), active });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    chrome.storage.sync.get(null, (stored) => {
      settings = sbMergeSettings(stored);
      restart();
    });
  });

  chrome.storage.sync.get(null, (stored) => {
    settings = sbMergeSettings(stored);
    if (!settings.enabled) return; // Toggled off: touch nothing.
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
})();
