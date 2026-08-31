# Score Blocker — Privacy Policy

**Effective date:** 29 August 2026
**Last updated:** 29 August 2026
**Extension:** Score Blocker (Chrome Extension)

## Summary

Score Blocker does not collect, store, transmit, or sell any personal information. It makes no
network requests of any kind. Everything it does happens locally in your browser.

## What the extension accesses

On the sites you have granted it access to, the extension reads the text of the page in order to
identify sports scores and spoiler wording, and applies a blur to the parts that match. It also
reads the page's address and title to judge whether a page looks sports-related, which decides
whether thumbnails are blurred.

This happens entirely in your browser, as the page is displayed. Page content is held in memory only
for as long as it takes to decide what to blur. It is never stored, logged, or sent anywhere.

## What the extension stores

Only your own settings:

- whether the extension is on
- whether Match Day mode is on
- which detection rules are enabled, and the keyword-proximity window
- display preferences (reveal on hover, blur while loading)
- your editable word lists: team names, sports keywords, and spoiler words
- any additional sites you have chosen to add

These are held in Chrome's extension storage (`chrome.storage.sync`). If you are signed in to
Chrome, Chrome synchronises them to your Google account so they follow you between your own devices.
That synchronisation is performed by Chrome itself, under Google's privacy policy; the developer of
this extension has no access to it and receives nothing.

## Data collection disclosure

| Category | Collected? |
| --- | --- |
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | No |

The extension contains no networking code, so no category of data can leave your device.

## What the extension does not do

- It makes no network requests.
- It contains no analytics, telemetry, tracking, or third-party code or services.
- It does not read or record your browsing history.
- It does not use remote or dynamically generated code; every file it runs is bundled in the
  package and reviewable in the source repository.
- It does not sell, share, or transfer any data, because it does not collect any.
- It does not use any data for advertising, credit assessment, or lending.

## Permissions and why they are needed

- **Storage** — to save the settings listed above.
- **Scripting** — to register and remove the extension's own bundled stylesheets and content script.
  This is what allows the extension to make no page changes at all while it is switched off.
- **google.com and youtube.com** — the two sites the extension is built to operate on.
- **Other sites (optional)** — never requested when you install. If you choose to add another site
  in the options page, Chrome shows you its own permission prompt for that one site, which you can
  decline. The extension does nothing on any site you have not added and approved, and removing a
  site gives the access back.

## Your choices and rights

Because no data is collected, there is nothing held about you to access, export, correct, or delete.

Your settings are yours and stay on your devices. You can clear them at any time by resetting the
lists in the options page, or by removing the extension, which deletes its stored settings. You can
revoke access to any site you added at any time, from the options page or from Chrome's own
extension settings.

## Children's privacy

The extension is not directed at children and collects no information from anyone, including
children under 13.

## Changes to this policy

If this policy changes, the updated version will be published at this address and the "last updated"
date above will change. Because the extension collects no data, any change is likely to be a
clarification rather than a change in practice.

## Contact

Questions or concerns: please open an issue at
https://github.com/MattHlav478/score-blocker-extension/issues
