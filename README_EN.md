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

The extension uses a multi-signal detection pipeline, trying each method by confidence level (highest first):

1. **Video Chapter Markers**: Reads chapter segments set by uploaders, matches ad-related labels
2. **Description Timestamps**: Parses timestamp lists in video descriptions to find ad-labeled segments
3. **Subtitle Content Analysis**: Fetches AI/manual subtitles, detects ad segments via keyword clustering; supports cross-layer subtitle + danmaku joint positioning
4. **Danmaku Time-Format Parsing**: Analyzes time markers in bullet comments (e.g., "5:30", "705工程")
5. **Danmaku Keyword Matching**: Uses directional keywords (start/end signals) for bidirectional anchoring

Any layer hit triggers the skip; remaining layers serve as fallback.

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

## Usage

### Basic Usage
1. After installing the extension, open any Bilibili video page
2. The extension will automatically analyze danmaku in the background to identify ad segments
3. Based on the selected mode:
   - **Auto Mode**: Automatically skips when ad segments are detected
   - **Manual Mode**: Shows "Skip Ad" button, click to skip

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

If time format recognition fails, the extension will try subtitle analysis and keyword matching as fallbacks.

## Project Structure

```
BiliSmartSkip/
├── scr/                    # Source files folder
│   ├── constants.js        # Keyword dictionaries & config constants
│   ├── utils.js            # Utility functions (logging, time formatting, Chinese numeral parsing)
│   ├── api.js              # API requests & Protobuf danmaku decoder
│   ├── detectors.js        # 5-layer ad detection algorithms
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
3. Load the development version in Chrome
4. Modify code and test
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
