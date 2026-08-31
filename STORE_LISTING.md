# Chrome Web Store submission

Copy for the Developer Dashboard, kept here so it stays versioned alongside the `manifest.json` it
describes. **If a permission is ever added or changed, update the matching justification below** —
a review that contradicts the previous one is worse than no submission.

Everything here is verified against the code, not asserted: the extension makes **no network
requests** (no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`), contains **no remote or
generated code** (no `eval`, no `new Function`, no dynamic `import()`, no external scripts or
stylesheets), and loads no third-party services or analytics.

---

## Permission justifications

### Storage

Score Blocker uses `chrome.storage.sync` to store the user's own configuration and nothing else:
the on/off state, the Match Day mode state, which detection rules are enabled, the
keyword-proximity window, the reveal-on-hover and pre-blur preferences, three user-editable word
lists (team names, sports keywords, spoiler words), and any additional site patterns the user has
chosen to add.

These settings are read by all four surfaces of the extension — the popup toggle, the options page,
the service worker (which sets the toolbar badge), and the content script. The content script also
subscribes to `chrome.storage.onChanged` so that toggling the extension takes effect on
already-open tabs immediately, without requiring a page reload.

`sync` rather than `local` is used so a user's tuned word lists follow them across their own
signed-in Chrome profiles. No browsing history, page content, or personal information is stored.
The extension makes no network requests of any kind, so no stored value is ever transmitted to the
developer or any third party.

### Scripting

The `scripting` permission is used exclusively for `chrome.scripting.registerContentScripts`,
`unregisterContentScripts`, and `getRegisteredContentScripts`. The extension never calls
`executeScript`, and never registers remote or dynamically generated code — every registered file
is a static CSS or JS file bundled in the package.

It is required for three things:

1. **Conditionally injecting two stylesheets and one small script at `document_start`.** A content
   script cannot run before the browser paints, so a score would be briefly readable while a page
   loads — both in the page (`content/preblur.css`, `content/lockdown.css`) and in the browser tab
   title (`content/titleguard.js`, which masks the score in `document.title`). None of these can be
   declared in the manifest, because manifest content scripts are injected unconditionally — that
   would act on pages even when the extension is switched off. Registering them from the service
   worker only while the relevant setting is on is precisely what makes "off" mean no page changes
   at all.
2. **Registering the content script for user-added sites**, after the user has granted permission
   for that origin, so adding a site does not require editing the manifest and reinstalling.
3. **Unregistering all of the above** the moment the corresponding setting is switched off.

### Host permissions

**Required hosts — `https://www.google.com/*` and `https://www.youtube.com/*`**

These are the two surfaces the extension exists to operate on. Its entire function is to find sports
scores and result spoilers in search results, video titles, descriptions and thumbnails, and to blur
them behind a click-to-reveal mask. That requires reading the text of the page and adding a CSS
class to the elements that match. Page content is examined in memory, on the page the user is
already looking at, solely to decide what to blur. It is never stored, logged, or transmitted — the
extension makes no network requests.

**Optional hosts — `*://*/*`**

This is never requested at install time and is never granted automatically. Users get spoiled on
sites beyond Google and YouTube — a sports news site, a forum, a different search engine — and which
sites those are differs per user and cannot be enumerated in advance, so they cannot be listed in
the manifest.

The options page therefore lets a user add a site themselves. When they type a match pattern and
click "Add site", the extension calls `chrome.permissions.request()` for that single origin; Chrome
shows its own permission prompt and the user can decline. The extension does nothing whatsoever on
any site the user has not explicitly added and approved, and removing a site from the list calls
`chrome.permissions.remove()` to give the access back.

This follows Chrome's recommended pattern of requesting narrow host permissions at runtime, in
response to an explicit user action, rather than requesting broad host access at install time.

---

## Single purpose

Score Blocker has one purpose: to hide sports scores and match-result spoilers on web pages until
the user chooses to reveal them.

## Data usage

Answer **No** to every "does this item collect or transmit" category — personally identifiable
information, health information, financial information, authentication information, personal
communications, location, web history, user activity, and website content. The extension contains no
networking code at all.

Tick all three certifications: no sale or transfer of user data to third parties; no use of data for
purposes unrelated to the item's single purpose; no use of data to determine creditworthiness or for
lending.

One nuance, stated plainly in `PRIVACY.md`: `chrome.storage.sync` does send the user's settings to
their own Google account so Chrome can sync them between their devices. That is Chrome's own sync
infrastructure and the developer has no access to it — but the policy says so rather than claiming
nothing ever leaves the device.

## Privacy policy

`PRIVACY.md` in this repository. Host it (GitHub Pages, or link the `raw.githubusercontent.com`
URL) and put that URL in the dashboard.

---

## Listing copy

**Short description** (132 char limit; matches the manifest description):

> Blurs sports scores in Google and YouTube results until you click to reveal them.

**Detailed description:**

> Searching for match highlights shouldn't spoil the result. Score Blocker finds score-shaped text
> in Google search results and YouTube titles, descriptions and thumbnails, and blurs it behind a
> click-to-reveal mask — so you can find the video without seeing how it ended.
>
> • One toggle. When it's off, the extension makes no changes to any page at all.
> • Blurs before the page paints, so a score is never briefly readable while loading.
> • Click any blurred item to reveal it. Nothing is deleted, so a false positive costs one click.
> • Match Day mode for when you're really avoiding a result: hides all result descriptions, any
>   headline containing spoiler wording, thumbnails on sports results, and the YouTube comments.
> • Tune it yourself: your own team names, sports keywords and spoiler words, all editable.
> • Add other sites you get spoiled on, with Chrome asking your permission for each one.
>
> No accounts, no tracking, no network requests. Everything runs locally in your browser.

**Category:** Productivity · **Language:** English

## Still needed before submitting

- At least one screenshot, 1280×800 or 640×400.
- A contact email, verified in the Developer Dashboard.
- The hosted privacy policy URL.

## Pre-submission check

```sh
# The claims above must stay true:
grep -rnE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function" \
  --include=*.js . | grep -v "^./test/"        # must be empty

node test/e2e.mjs && node test/preblur.mjs && node test/matchday.mjs
```

Then load the packaged build once via **Load unpacked** and confirm no console errors in either the
page or the service worker.
