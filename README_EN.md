# Bilibili Ad Skip Assistant (BiliSmartSkip)

[中文](README.md) | English

A Chrome / Firefox extension for skipping ad breaks in Bilibili videos.

## Features

- Choose automatic skipping or click a button to skip manually.
- Set a custom skip shortcut.
- Skip multiple ad breaks in the same video.

## How It Works

The extension uses local rules to estimate where ads start and end, based on chapters, descriptions, subtitles, and danmaku. It looks for clues such as chapters marked as ads, viewer comments like “空降 5:30” (skip to 5:30), and sponsorship or promotional content in subtitles.

If it finds a possible ad but cannot establish its boundaries, or the sources disagree on the timing, it asks you to click the skip button even in automatic mode. It can still miss ads or mistake other content for an ad.

Each ad break is skipped automatically only once. If you seek back into it, you can click the button to skip it again.

## Installation

### From the browser store

- [Chrome Web Store](https://chromewebstore.google.com/detail/ecpppfmdhkopohdmplcafmbfoggijcpe)
- [Firefox Add-ons](https://addons.mozilla.org/en-CA/firefox/addon/bilismartskip/)

### Load the source in Chrome

1. Download and extract the source.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the directory containing `manifest.json`.

After updating the source, click **Reload** on the extensions page and refresh the video page.

## Usage

Open a Bilibili video after installing the extension. Manual mode is the default: a button appears when it detects an ad. Click the extension icon in the browser toolbar to switch to automatic mode; the setting is saved automatically. Possible ads that need confirmation still require a click in automatic mode.

To set a shortcut, open the extension popup, click **设置** (Set) under **跳过快捷键** (Skip shortcut), and press a key combination such as `Alt + S`. Click **重置** (Reset) to clear it.

## Danmaku time formats

Supported examples include `5:30`, `五分三十秒` (five minutes thirty seconds), `5分30秒`, and `10.5分钟`. The extension also understands `705工程` and `0705工程` as 7 minutes 5 seconds.

A time can appear in an ordinary comment too, so the extension also checks for nearby skip instructions such as “空降” or “跳过广告”.

## Project Structure

```
BiliSmartSkip/
├── scr/                    # Extension source
│   ├── constants.js        # Keywords and configuration
│   ├── utils.js            # Logging and time parsing
│   ├── api.js              # Fetch video info, subtitles, and danmaku
│   ├── page-data.js        # Read public video metadata already loaded by the page
│   ├── detectors.js        # Detection rules for each source
│   ├── segment-detector.js # Find ad start and end times
│   ├── skipper.js          # Skip button, countdown, and player seeking
│   ├── content.js          # Setup and page navigation
│   ├── popup.html          # Settings popup
│   ├── popup.js            # Save mode and shortcut settings
│   └── icon.png            # Extension icon
├── LICENSE                 # Open source license
├── README.md               # Project documentation (Chinese)
├── README_EN.md            # Project documentation (English)
└── manifest.json           # Extension configuration file
```

## Permissions and data

- `storage`: Save mode and shortcut settings locally.
- `www.bilibili.com`: Run the extension on video pages.
- `api.bilibili.com`: Fetch video information, chapters, and subtitle URLs.
- `comment.bilibili.com`: Fetch danmaku.
- `i0.hdslb.com`, `aisubtitle.hdslb.com`: Download subtitle files.

## Development checks

Test files are kept on `test-branch`. Run data fetching and fallback tests with Node.js:

```sh
git checkout test-branch
node --test tests/*.test.cjs
```

## Feedback and contributions

Issues and pull requests are welcome. To report an incorrect or missed skip, include the video link, the relevant timestamp, and whether you used automatic or manual mode so the issue can be reproduced.

## License

[GNU GPL v2](LICENSE).

## Changelog

### v2.1.0

- Added support for skipping multiple ad segments in one video.
- Improved ad boundaries using subtitle context, chapters, and danmaku timestamps.
- Prevented ordinary keyword matches from triggering automatic skips; conflicting boundaries require manual confirmation.
- Fixed video metadata fetching failures and incorrect part selection in multi-part videos.
- Made detection and skip logs respect the DEBUG setting and removed duplicate logs.

### v2.0.0

- Added chapter, description timestamp, and subtitle detection.
- Combined subtitles and danmaku to locate ad start and end times.
- Added a skip shortcut.
- Added support for time formats such as `705工程`.
- Expanded keywords and distinguished comments marking ad starts from those marking ad ends.

### v1.1.0

- Added a countdown prompt.
- Adjusted ad detection rules.

### v1.0.0

Initial release with automatic and manual skipping based on danmaku timestamps.

## Screenshot

![Skip ad button](./img/full_screen.png)
