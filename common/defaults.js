/**
 * Shared settings schema for Score Blocker.
 *
 * Loaded as the first content script, via <script> in popup/options, and via
 * importScripts() in the service worker, so it must stay dependency-free and
 * must not touch the DOM.
 */

const SB_BUILTIN_SITES = ['https://www.google.com/*', 'https://www.youtube.com/*'];

/**
 * Blocks that carry a result's description / snippet / metadata text.
 *
 * Match Day blurs every one of these. content/lockdown.css MUST list the same
 * selectors — CSS cannot read this file, so test/matchday.mjs parses the
 * stylesheet and fails if the two ever drift apart.
 */
const SB_DESCRIPTION_SELECTORS = [
  // Google: result snippets in the results column
  '#center_col .VwiC3b',
  '#center_col [data-sncf]',
  '#rso [data-sncf]',
  '#search .VwiC3b',
  // YouTube: metadata snippets, descriptions, watch-page description box
  '.metadata-snippet-text',
  '#description-text',
  'ytd-video-renderer #description-text',
  '#description-inline-expander',
  'ytd-expandable-video-description-body-renderer'
];
const SB_DESCRIPTION_SELECTOR = SB_DESCRIPTION_SELECTORS.join(', ');

/**
 * Video surfaces worth blurring: real players, and the iframe embeds sites use
 * to host one. A poster frame is part of its <video>, so it blurs with it.
 */
const SB_VIDEO_SELECTORS = [
  'video',
  'iframe[allowfullscreen]',
  'iframe[allow*="fullscreen"]',
  'iframe[src*="youtube.com"]',
  'iframe[src*="youtube-nocookie.com"]',
  'iframe[src*="youtu.be"]',
  'iframe[src*="vimeo.com"]',
  'iframe[src*="dailymotion.com"]',
  'iframe[src*="brightcove"]',
  'iframe[src*="jwplayer"]',
  'iframe[src*="streamable.com"]'
];
const SB_VIDEO_SELECTOR = SB_VIDEO_SELECTORS.join(', ');

/** The comment surfaces Match Day blurs wholesale rather than word by word. */
const SB_COMMENTS_SELECTORS = ['ytd-comments#comments', '#comments ytd-item-section-renderer'];
const SB_COMMENTS_SELECTOR = SB_COMMENTS_SELECTORS.join(', ');

const SB_DEFAULT_KEYWORDS = [
  'final score',
  'full time',
  'full-time',
  'FT',
  'HT',
  'half time',
  'half-time',
  'match report',
  'result',
  'results',
  'highlights',
  'extended highlights',
  'recap',
  'final whistle',
  'post-match',
  'post match',
  'aggregate',
  'on aggregate',
  'penalties',
  'scoreline',
  'beat',
  'defeat',
  'win',
  'draw'
];

/**
 * Words that spoil a result on their own, with no scoreline present.
 *
 * Deliberately aggressive: these only ever run while Match Day is on, so the
 * tolerance for a false positive is much higher than for the always-on rules.
 */
const SB_DEFAULT_SPOILER_KEYWORDS = [
  'stun',
  'stunned',
  'stunning',
  'upset',
  'comeback',
  'collapse',
  'thrash',
  'thrashed',
  'hammer',
  'humiliate',
  'celebrate',
  'celebration',
  'red card',
  'sent off',
  'hat-trick',
  'hat trick',
  'equaliser',
  'equalizer',
  'late winner',
  'winner',
  'knocked out',
  'knocks out',
  'advance',
  'eliminated',
  'survive',
  'relegated',
  'promoted',
  'clinch',
  'seal',
  'stunner',
  'heartbreak',
  'dominant',
  'demolish',
  'shock',
  'crash out',
  'through to'
];

const SB_DEFAULT_TEAMS = [
  'Arsenal',
  'Aston Villa',
  'Barcelona',
  'Bayern',
  'Chelsea',
  'Dortmund',
  'Everton',
  'Inter',
  'Juventus',
  'Liverpool',
  'Man City',
  'Man United',
  'Manchester City',
  'Manchester United',
  'Milan',
  'Newcastle',
  'PSG',
  'Real Madrid',
  'Spurs',
  'Tottenham'
];

const SB_DEFAULTS = {
  // Master on/off switch. When false the content script does nothing at all.
  enabled: true,
  rules: {
    // "2-1" plus a sports keyword nearby.
    numericKeyword: true,
    // A name from the personal team list next to a score.
    teamList: true,
    // "Team A vs Team B 2-1" style video titles.
    vsPattern: true,
    // Blur the thumbnail of a video whose title/metadata matched.
    thumbnailBlur: true,
    // YouTube comments are noisy; off by default.
    scanComments: false
  },
  // How many characters either side of a score we look in for a keyword.
  keywordWindow: 60,
  // Reveal a mask by hovering it, not just by clicking. Off by default so the
  // cursor drifting across a page of results can't spoil anything.
  revealOnHover: false,
  // Blur result text from the very first paint, before the scanner has run, so
  // a score is never briefly readable while the page loads.
  preBlur: true,
  // Mask a score in the browser tab title. A tab title cannot be blurred - it
  // is browser chrome, not page content - so the matched text is replaced with
  // a placeholder and the original restored when the extension is switched off.
  maskTabTitle: true,
  // Blur every video player, embed and poster frame on the page. Aggressive
  // enough to be off by default; Match Day switches it on regardless.
  blurVideos: false,
  // Match Day: the manual lockdown switch. Off means the extension behaves
  // exactly as it does without this feature.
  matchDay: false,
  strict: {
    // Blur every result description / snippet.
    blurDescriptions: true,
    // Blur a whole block that contains spoiler vocabulary.
    spoilerWords: true,
    // Blur thumbnails on results that look sports-related.
    thumbnails: true,
    // Blur the YouTube comments section as a single block.
    blurComments: true
  },
  keywords: SB_DEFAULT_KEYWORDS.slice(),
  spoilerKeywords: SB_DEFAULT_SPOILER_KEYWORDS.slice(),
  teams: SB_DEFAULT_TEAMS.slice(),
  // Extra match patterns added at runtime from the options page. The built-in
  // Google/YouTube patterns live in the manifest and are not listed here.
  sites: []
};

/** Merge a raw chrome.storage object over the defaults, filling any gaps. */
function sbMergeSettings(stored) {
  const raw = stored || {};
  const merged = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : SB_DEFAULTS.enabled,
    rules: Object.assign({}, SB_DEFAULTS.rules, raw.rules || {}),
    keywordWindow: Number.isFinite(raw.keywordWindow)
      ? Math.min(400, Math.max(0, Math.round(raw.keywordWindow)))
      : SB_DEFAULTS.keywordWindow,
    revealOnHover:
      typeof raw.revealOnHover === 'boolean' ? raw.revealOnHover : SB_DEFAULTS.revealOnHover,
    preBlur: typeof raw.preBlur === 'boolean' ? raw.preBlur : SB_DEFAULTS.preBlur,
    maskTabTitle:
      typeof raw.maskTabTitle === 'boolean' ? raw.maskTabTitle : SB_DEFAULTS.maskTabTitle,
    blurVideos: typeof raw.blurVideos === 'boolean' ? raw.blurVideos : SB_DEFAULTS.blurVideos,
    matchDay: typeof raw.matchDay === 'boolean' ? raw.matchDay : SB_DEFAULTS.matchDay,
    strict: Object.assign({}, SB_DEFAULTS.strict, raw.strict || {}),
    keywords: Array.isArray(raw.keywords) ? raw.keywords : SB_DEFAULTS.keywords.slice(),
    spoilerKeywords: Array.isArray(raw.spoilerKeywords)
      ? raw.spoilerKeywords
      : SB_DEFAULTS.spoilerKeywords.slice(),
    teams: Array.isArray(raw.teams) ? raw.teams : SB_DEFAULTS.teams.slice(),
    sites: Array.isArray(raw.sites) ? raw.sites : SB_DEFAULTS.sites.slice()
  };
  merged.keywords = merged.keywords.map((s) => String(s).trim()).filter(Boolean);
  merged.spoilerKeywords = merged.spoilerKeywords.map((s) => String(s).trim()).filter(Boolean);
  merged.teams = merged.teams.map((s) => String(s).trim()).filter(Boolean);
  merged.sites = merged.sites.map((s) => String(s).trim()).filter(Boolean);
  return merged;
}

if (typeof self !== 'undefined') {
  self.SB_DEFAULTS = SB_DEFAULTS;
  self.SB_BUILTIN_SITES = SB_BUILTIN_SITES;
  self.SB_DEFAULT_KEYWORDS = SB_DEFAULT_KEYWORDS;
  self.SB_DEFAULT_TEAMS = SB_DEFAULT_TEAMS;
  self.SB_DEFAULT_SPOILER_KEYWORDS = SB_DEFAULT_SPOILER_KEYWORDS;
  self.SB_DESCRIPTION_SELECTORS = SB_DESCRIPTION_SELECTORS;
  self.SB_DESCRIPTION_SELECTOR = SB_DESCRIPTION_SELECTOR;
  self.SB_COMMENTS_SELECTORS = SB_COMMENTS_SELECTORS;
  self.SB_COMMENTS_SELECTOR = SB_COMMENTS_SELECTOR;
  self.SB_VIDEO_SELECTORS = SB_VIDEO_SELECTORS;
  self.SB_VIDEO_SELECTOR = SB_VIDEO_SELECTOR;
  self.sbMergeSettings = sbMergeSettings;
}
