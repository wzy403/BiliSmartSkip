# Bilibili Ad Skip Assistant (BiliSmartSkip)

[中文](README.md) | English

An intelligent Chrome browser extension that automatically identifies embedded ad segments in Bilibili videos by analyzing bullet comments (danmaku) and provides automatic or manual skip functionality.

## ✨ Features

- 🎯 **Smart Detection**: Precisely identifies ad segments by analyzing time information in bullet comments
- 🤖 **Auto Skip**: Supports automatic ad segment skipping without manual intervention
- 👆 **Manual Skip**: Displays skip button during ad segments for user choice
- 🔄 **Mode Switching**: Freely switch between automatic and manual modes
- 🚀 **Lightweight & Efficient**: No background processes, no impact on page performance
- 🎨 **User-Friendly Interface**: Beautiful skip button and settings UI

## 🎭 How It Works

The extension intelligently identifies ad segments through the following steps:

1. **Fetch Danmaku Data**: Retrieves the danmaku XML file for the current video from Bilibili API
2. **Parse Time Information**: Analyzes time markers in danmaku content (e.g., "5:30", "five minutes thirty seconds")
3. **Statistical Analysis**: Calculates confidence scores for identical time points in danmaku
4. **Determine Ad Segments**: Identifies ad start and end times based on statistical results
5. **Execute Skip**: Performs automatic skip or displays manual skip button based on user settings

## 📦 Installation

### Method 1: Install from Chrome Web Store (Recommended)
1. Open [Bilibili 广告跳过助手 - Chrome Web Store](https://chromewebstore.google.com/detail/ecpppfmdhkopohdmplcafmbfoggijcpe)
2. Click "Add to Chrome"

### Method 2: Developer Mode Installation
1. Download all project files
2. Open Chrome browser and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the folder containing the extension files

## 📖 Usage

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

## 🎯 Supported Time Formats

The extension can recognize various time formats in danmaku:

- **Numeric Format**: `5:30`, `10:45`
- **Chinese Numbers**: `五分三十秒` (five minutes thirty seconds), `十分钟` (ten minutes)
- **Mixed Format**: `5分30秒`, `10.5分钟`
- **English Format**: `5min30s`, `10m`

If the time format recognition fails, the extension will attempt to use keyword matching for identification.

## 📁 Project Structure

```
BiliSmartSkip/
├── scr/                    # Source files folder
│   ├── content.js          # Content script with main logic
│   ├── popup.html          # Extension popup interface
│   ├── popup.js            # Popup interaction logic
│   └── icon.png            # Extension icon
├── LICENSE                 # Open source license
├── README.md               # Project documentation (Chinese)
├── README_EN.md            # Project documentation (English)
└── manifest.json           # Extension configuration file
```

## 🛡️ Permissions Explained

- `storage`: Save user mode settings
- `https://www.bilibili.com/*`: Access Bilibili video pages
- `https://comment.bilibili.com/*`: Retrieve danmaku data

## 🔒 Privacy Protection

- This extension does not collect any personal information
- All data processing is performed locally
- Only accesses publicly available Bilibili danmaku API
- No data is sent to third-party servers

## 🐛 Troubleshooting

If you encounter issues while using the extension:

1. Ensure you're using it on Bilibili video pages
2. Confirm the extension is properly installed and enabled
3. Try refreshing the page
4. Check browser console for error messages

## 🤝 Contributing

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

## 📄 License

This project is licensed under the [GUN License](LICENSE).

## 📈 Version History

### v1.1.0
- 🎉 Added countdown skip feature
- ✅ Optimized ad segment recognition algorithm

### v1.0.0
- 🎉 Initial release
- ✅ Support for auto/manual skip modes
- ✅ Intelligent danmaku time recognition
- ✅ Beautiful user interface

## ⚙️ Settings Interface & Ad Skip Functionality

Clean, intuitive settings panel with one-click auto/manual skip toggle.
When an ad is detected, a sleek "Skip Ad" button appears bottom-right for instant skipping.

![Ad Skip Feature Demo](./img/full_screen.png)