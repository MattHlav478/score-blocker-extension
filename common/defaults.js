/**
 * Shared settings schema for Score Blocker.
 *
 * Loaded as the first content script, via <script> in popup/options, and via
 * importScripts() in the service worker, so it must stay dependency-free and
 * must not touch the DOM.
 */

const SB_BUILTIN_SITES = ['https://www.google.com/*', 'https://www.youtube.com/*'];

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
  keywords: SB_DEFAULT_KEYWORDS.slice(),
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
    keywords: Array.isArray(raw.keywords) ? raw.keywords : SB_DEFAULTS.keywords.slice(),
    teams: Array.isArray(raw.teams) ? raw.teams : SB_DEFAULTS.teams.slice(),
    sites: Array.isArray(raw.sites) ? raw.sites : SB_DEFAULTS.sites.slice()
  };
  merged.keywords = merged.keywords.map((s) => String(s).trim()).filter(Boolean);
  merged.teams = merged.teams.map((s) => String(s).trim()).filter(Boolean);
  merged.sites = merged.sites.map((s) => String(s).trim()).filter(Boolean);
  return merged;
}

if (typeof self !== 'undefined') {
  self.SB_DEFAULTS = SB_DEFAULTS;
  self.SB_BUILTIN_SITES = SB_BUILTIN_SITES;
  self.SB_DEFAULT_KEYWORDS = SB_DEFAULT_KEYWORDS;
  self.SB_DEFAULT_TEAMS = SB_DEFAULT_TEAMS;
  self.sbMergeSettings = sbMergeSettings;
}
