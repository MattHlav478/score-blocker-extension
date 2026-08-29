# Score Blocker

A personal-use Manifest V3 Chrome extension that blurs sports scores in Google and YouTube
results until you click to reveal them. One toggle: when it's off, the extension makes no
page changes at all — no scanning, no observer, no DOM edits.

The case it's built for: searching *"Chelsea match extended highlights"*, getting a wall of
results whose titles and snippets give away the final score before you've watched anything.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Pin the toolbar icon. The badge reads `ON` / `OFF`.

## What it hides

Text matching any enabled rule is wrapped in a blurred span with a small 🚫 marker beside it
(the marker sits outside the blur so a mask never reads as a rendering glitch). Click a mask —
or press Enter/Space when it's focused — to reveal it. Reveals are deliberately temporary: a
re-render, a scroll-back, or a re-navigation blurs it again.

| Rule | Matches | Notes |
| --- | --- | --- |
| Score pair near a keyword | `2-1` within the keyword window of "highlights", "full time", "final score", … | Broadest rule; tune the window if it over-blurs |
| Team name near a score | `Chelsea 2-1`, `Chelsea 3 Arsenal 0` | Highest confidence; fires with no keyword present |
| "vs" pattern | `Team A vs Team B 2-1` | YouTube titles, independent of the team list |
| Thumbnail blur | The `<img>` of a video whose title/metadata matched | Partial mitigation, see limits |
| Scan comments | YouTube comment threads | Off by default — noisy |

Every rule, the keyword window, the team list, the keyword list, and hover-reveal are editable
on the options page. Settings live in `chrome.storage.sync`, and every change applies to
already-open tabs immediately — no reload.

## Known limits

- **Scores baked into thumbnail pixels can't be text-matched.** The thumbnail rule blurs the
  image when the *adjacent text* looks like a highlights video. It is a heuristic, not OCR, so
  a thumbnail whose title gives nothing away will still show its scoreboard.
- **Regex detection has false positives and negatives.** That's why masking is a reversible
  blur rather than deletion — a wrong guess costs one click. If unrelated numbers get blurred,
  lower the keyword window or trim the keyword list.
- Google's and YouTube's markup changes periodically. Scanning is deliberately structure-
  agnostic (text nodes grouped by block container, with only navigation chrome excluded), so a
  class-name change shouldn't break it.
- Personal use, side-loaded: no Chrome Web Store listing overhead.

## Adding other sites

Google and YouTube are in the manifest. Other sites are added at runtime from the options page:
enter a match pattern (e.g. `https://www.reddit.com/*`), Chrome prompts for permission, and the
service worker registers the content script for it via `chrome.scripting.registerContentScripts`.
No manifest editing, no extension reload.

## Layout

```
manifest.json
background.js         service worker: defaults, badge, dynamic site registration
common/defaults.js    shared settings schema (content script, popup, options, worker)
content/content.js    scanning, detection, masking, MutationObserver, SPA navigation
content/content.css   blur + reveal styles
popup/                on/off toggle and live "X scores hidden" count
options/              rules, keyword window, team/keyword lists, extra sites
test/e2e.mjs          end-to-end tests against the real extension in Chromium
```

## Tests

```
node test/e2e.mjs
```

Loads the real extension into Chromium against local fixtures that mimic Google and YouTube
markup, and covers the checklist: masking and reveal, false-positive spot checks, the
MutationObserver picking up lazily-loaded results, `yt-navigate-finish` rescans, comments and
navigation chrome being skipped, thumbnail blur, toggling off mid-session restoring the exact
original text with zero leftover nodes, and the popup/options pages reading and writing storage.

Requires Playwright (`npm i -g playwright` or a local install); the runner resolves either.
