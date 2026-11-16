# Bilibili Ad Skip Assistant (BiliSmartSkip)

[中文](README.md) | English

An intelligent Chrome/Firefox browser extension that automatically identifies embedded ad segments in Bilibili videos using multi-signal analysis and provides automatic or manual skip functionality.

## Features

- **Multi-Signal Smart Detection**: Combines video chapters, description, subtitles, and danmaku for precise ad identification
- **Auto Skip**: Supports automatic ad segment skipping without manual intervention
- **Manual Skip**: Displays skip button during ad segments for user choice
- **Custom Shortcut Key**: Set a keyboard shortcut to skip ads instantly in manual mode
- **Mode Switching**: Freely switch between automatic and manual modes
- **Lightweight & Efficient**: No background processes, no impact on page performance
- **User-Friendly Interface**: Beautiful skip button and settings UI

## How It Works

The extension uses local rules to estimate where ads start and end, based on chapters, descriptions, subtitles, and danmaku. It looks for clues such as chapters marked as ads, viewer comments like “空降 5:30” (skip to 5:30), and sponsorship or promotional content in subtitles.

Each ad break is skipped automatically only once. If you seek back into it, you can click the button to skip it again.

## Installation

### Method 1: Install from existing/add-on Store (Recommended)
| Browser | Installation Steps |
|--------|----------|
| **Chrome** | 1. Open [Chrome Web Store](https://chromewebstore.google.com/detail/ecpppfmdhkopohdmplcafmbfoggijcpe)<br>2. Click **「Add to Chrome」** |
| **Firefox** | 1. Open [Firefox Add-ons](https://addons.mozilla.org/en-CA/firefox/addon/bilismartskip/)<br>2. Click **「Add to Firefox」** |


### Method 2: Developer Mode Installation
1. Download all project files
2. Open Chrome browser and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the folder containing the extension files

After updating the source, click **Reload** on the extensions page and refresh the video page.

## Usage

Open a Bilibili video after installing the extension. Manual mode is the default: a button appears when it detects an ad. Click the extension icon in the browser toolbar to switch to automatic mode; the setting is saved automatically. Possible ads that need confirmation still require a click in automatic mode.

To set a shortcut, open the extension popup, click **设置** (Set) under **跳过快捷键** (Skip shortcut), and press a key combination such as `Alt + S`. Click **重置** (Reset) to clear it.

## Danmaku time formats

Supported examples include `5:30`, `五分三十秒` (five minutes thirty seconds), and `5分30秒`. The extension also understands `705工程` and `0705工程` as 7 minutes 5 seconds, and `向右13下` as 13 presses of the right arrow key.

A time can appear in an ordinary comment too, so the extension also checks for nearby skip instructions such as “空降” or “跳过广告”.

## Project Structure

```
BiliSmartSkip/
├── scr/                    # Extension source
│   ├── constants.js        # Configuration
│   ├── utils.js            # Logging helpers
│   ├── api.js              # Fetch video info, subtitles, and danmaku
│   ├── page-data.js        # Read public video metadata already loaded by the page
│   ├── detectors.js        # Chapter and description labels; subtitle evidence categories
│   ├── ad-signals.js       # Viewer instructions, confirmations, ad reactions, and sponsor reads in subtitles
│   ├── pitch-model.js      # Word table for sponsor reads (generated; do not edit by hand)
│   ├── segment-detector.js # Complete breaks from a sponsor statement to the return to the video
│   ├── skipper.js          # Skip button, countdown, and player seeking
│   ├── content.js          # Setup, page navigation, and weighing the evidence
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

Tests, offline evaluation, and the script that generates the word table are kept on `test-branch` and are not shipped with the extension. To test a branch, export its source to a temporary directory (`master` in this example). Node.js 20+ is required; there are no other dependencies:

```sh
git checkout test-branch
SRC=$(mktemp -d) && git archive master scr manifest.json | tar -x -C "$SRC"
BILISMARTSKIP_SOURCE_DIR="$SRC/scr" node --test tests/*.test.cjs
```

`scr/pitch-model.js` is generated by `eval/train-pitch-model.cjs` on `test-branch` from the subtitles of reviewed videos; regenerate it after changing the feature extraction in `ad-signals.js`. The evaluation method and current results are described in `eval/README.md` on that branch.

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
