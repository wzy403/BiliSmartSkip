# Bilibili Ad Skip Assistant (BiliSmartSkip)

[中文](README.md) | English

An intelligent Chrome/Firefox browser extension that automatically identifies embedded ad segments in Bilibili videos using multi-signal analysis and provides automatic or manual skip functionality.

## Features

- **Multi-Signal Detection**: Cross-checks chapters, descriptions, subtitles, and danmaku for commercial evidence and segment boundaries
- **Confidence-Aware Skipping**: High-confidence segments can skip automatically; uncertain or conflicting results require a manual click
- **Multiple Segments**: Handles separate breaks without skipping the main content between them, with at most one automatic skip per interval
- **Manual Skip**: Displays skip button during ad segments for user choice
- **Custom Shortcut Key**: Set a keyboard shortcut to skip ads instantly in manual mode
- **Mode Switching**: Freely switch between automatic and manual modes
- **Lightweight & Efficient**: No background processes, no impact on page performance
- **User-Friendly Interface**: Beautiful skip button and settings UI

## How It Works

The extension finds candidate intervals locally, then checks their content and boundary evidence before allowing automatic skipping:

1. **Explicit Chapter and Description Labels**: Uses creator-marked ad intervals. Ordinary discussion of advertising and negated labels do not directly authorize automatic skipping.
2. **Viewer-Written Skip Destinations**: Parses times next to explicit instructions such as “跳过广告”, “空降”, or “跳伞”. Ordinary time references and repeated bare timestamps remain suggestions requiring confirmation.
3. **Subtitles and Complete Breaks**: Combines sponsorship openings, continued promotion, a return to the main topic, chapter boundaries, and danmaku destinations to identify one or more complete intervals. Generic words such as “free”, “search”, or “purchase” alone do not establish an ad.
4. **Cross-Source Checks**: Explicit skip destinations take priority over scattered subtitle keyword estimates. Conflicts with a return to the main topic, continuing promotion, or other explicit destinations require manual confirmation.

Keyword matches alone, uncertain boundaries, and other low-confidence results do not silently trigger automatic skips. A brief sponsorship credit or a video about a product is not automatically a separate ad break. Console logs include detection sources, matched evidence, confirmation requirements, and actual seeks.

## Installation

### Method 1: Install from existing/add-on Store (Recommended)
| Browser | Installation Steps |
|--------|----------|
| **Chrome** | 1. Open [Chrome Web Store](https://chromewebstore.google.com/detail/ecpppfmdhkopohdmplcafmbfoggijcpe)<br>2. Click **「Add to Chrome」** |
| **Firefox** | 1. Open [Firefox Add-ons](https://addons.mozilla.org/en-CA/firefox/addon/bilismartskip/)<br>2. Click **「Add to Firefox」** |


### Method 2: Developer Mode Installation
1. Download the source from the production `master` branch, or unpack a release extension ZIP. Do not use `test-branch` as the production download.
2. Open Chrome browser and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the directory directly containing `manifest.json` and `scr/`. These are the only runtime files required; tests, evaluation, and collection tools belong to the test branch and are not part of installation.

The store links install the published version. Local source fixes do not update an extension already installed from a store. After updating local files, click “Reload” on the extensions page and refresh the video page.

## Usage

### Basic Usage
1. After installing the extension, open any Bilibili video page
2. The extension reads available chapters, descriptions, subtitles, and danmaku to identify candidate intervals locally
3. Based on the selected mode:
   - **Auto Mode**: Automatically skips only high-confidence intervals; uncertain candidates still need a click
   - **Manual Mode**: Shows a skip button during candidate intervals; click to skip

### Mode Switching
1. Click the extension icon in the browser toolbar
2. Use the toggle switch to change between "Manual" and "Auto" modes
3. Settings are automatically saved and applied across all tabs

### Setting a Skip Shortcut Key
1. Click the extension icon in the browser toolbar
2. Click the "Set" button in the "Skip Shortcut" section
3. Press your desired key combination (e.g., `Alt + S`)
4. The shortcut is saved automatically — press it in manual mode to skip ads
5. To remove the shortcut, click the "Reset" button

## Supported Time Formats

The extension can recognize various time formats in danmaku:

- **Numeric Format**: `5:30`, `10:45`
- **Chinese Numbers**: `五分三十秒` (five minutes thirty seconds), `十分钟` (ten minutes)
- **Mixed Format**: `5分30秒`, `10.5分钟`
- **Encoded Format**: `705工程`, `0705工程` (viewer-used time encoding)

Parsing a time does not itself authorize a skip. The extension also checks nearby skip intent, interval validity, and boundary evidence from other sources.

## Project Structure

```
BiliSmartSkip/
├── scr/                    # Source files folder
│   ├── constants.js        # Keyword dictionaries & config constants
│   ├── utils.js            # Utility functions (logging, time formatting, Chinese numeral parsing)
│   ├── api.js              # API requests & Protobuf danmaku decoder
│   ├── detectors.js        # Source detectors and confidence checks
│   ├── segment-detector.js # Complete intervals and cross-source boundary checks
│   ├── skipper.js          # Skip button UI & countdown logic
│   ├── content.js          # Main entry: init, lifecycle, detection pipeline
│   ├── popup.html          # Extension popup interface
│   ├── popup.js            # Popup interaction logic
│   └── icon.png            # Extension icon
├── LICENSE                 # Open source license
├── README.md               # Project documentation (Chinese)
├── README_EN.md            # Project documentation (English)
└── manifest.json           # Extension configuration file
```

## Permissions Explained

- `storage`: Save user mode settings and shortcut key configuration
- `https://www.bilibili.com/*`: Access Bilibili video pages
- `https://api.bilibili.com/*`: Fetch video info, chapter markers, and subtitle data
- `https://comment.bilibili.com/*`: Retrieve danmaku data
- `https://i0.hdslb.com/*` / `https://aisubtitle.hdslb.com/*`: Fetch subtitle files

## Privacy Protection

- This extension does not collect any personal information
- All data processing is performed locally
- Only accesses Bilibili's public video info, subtitle, and danmaku APIs
- No data is sent to third-party servers

## Contributing

Issues and Pull Requests are welcome!

### Development Setup
1. Fork this project
2. Clone to local machine
3. Load the production code directory in Chrome
4. Run `node --test tests/*.test.cjs` on `test-branch`, which retains regression fixtures and offline evaluation tools
5. Submit Pull Request

### Code Standards
- Use ES6+ syntax
- Add necessary comments
- Follow existing code style

## License

This project is licensed under the [GUN License](LICENSE).

## Version History

### v2.0.0
- 🎉 Multi-signal detection pipeline: video chapters, description timestamps, subtitle analysis
- 🎉 Cross-layer subtitle + danmaku joint positioning for better ad boundary accuracy
- 🎉 Custom skip shortcut key — press a keyboard shortcut to skip ads in manual mode
- ✅ Support for "705工程" encoded time format
- ✅ Upgraded danmaku keywords to directional bidirectional anchoring algorithm
- ✅ Significantly expanded ad keyword dictionary

### v1.1.0
- 🎉 Added countdown skip feature
- ✅ Optimized ad segment recognition algorithm

### v1.0.0
- 🎉 Initial release
- ✅ Support for auto/manual skip modes
- ✅ Intelligent danmaku time recognition
- ✅ Beautiful user interface

## Settings Interface & Ad Skip Functionality

Clean, intuitive settings panel with one-click auto/manual skip toggle.
When an ad is detected, a sleek "Skip Ad" button appears bottom-right for instant skipping.

![Ad Skip Feature Demo](./img/full_screen.png)
