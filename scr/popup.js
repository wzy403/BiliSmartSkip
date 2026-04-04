document.addEventListener('DOMContentLoaded', () => {
  const switchInput = document.getElementById('modeSwitch');
  const modeText = document.getElementById('modeText');
  const shortcutDisplay = document.getElementById('shortcutDisplay');
  const setShortcutBtn = document.getElementById('setShortcut');
  const resetShortcutBtn = document.getElementById('resetShortcut');

  let isRecording = false;
  let recordingListener = null;

  // 初始化状态
  chrome.storage.local.get(['skipMode', 'skipShortcut'], result => {
    const currentMode = result.skipMode || 'manual';
    switchInput.checked = currentMode === 'auto';
    updateText(currentMode);

    if (result.skipShortcut) {
      shortcutDisplay.textContent = formatShortcut(result.skipShortcut);
    }
  });

  switchInput.addEventListener('change', () => {
    const mode = switchInput.checked ? 'auto' : 'manual';
    chrome.storage.local.set({ skipMode: mode }, () => {
      updateText(mode);
    });
  });

  function updateText(mode) {
    modeText.textContent = `当前：${mode === 'auto' ? '自动跳过' : '手动跳过'}`;
  }

  // === 快捷键设置 ===
  function formatShortcut(sc) {
    const parts = [];
    if (sc.ctrlKey) parts.push('Ctrl');
    if (sc.altKey) parts.push('Alt');
    if (sc.shiftKey) parts.push('Shift');
    if (sc.metaKey) parts.push('⌘');
    let keyName = sc.code;
    if (keyName.startsWith('Key')) keyName = keyName.slice(3);
    else if (keyName.startsWith('Digit')) keyName = keyName.slice(5);
    else if (keyName.startsWith('Arrow')) keyName = keyName.slice(5) + '箭头';
    else if (keyName === 'Backquote') keyName = '`';
    else if (keyName === 'Minus') keyName = '-';
    else if (keyName === 'Equal') keyName = '=';
    else if (keyName === 'BracketLeft') keyName = '[';
    else if (keyName === 'BracketRight') keyName = ']';
    else if (keyName === 'Backslash') keyName = '\\';
    else if (keyName === 'Semicolon') keyName = ';';
    else if (keyName === 'Quote') keyName = "'";
    else if (keyName === 'Comma') keyName = ',';
    else if (keyName === 'Period') keyName = '.';
    else if (keyName === 'Slash') keyName = '/';
    parts.push(keyName);
    return parts.join(' + ');
  }

  function stopRecording() {
    if (recordingListener) {
      document.removeEventListener('keydown', recordingListener);
      recordingListener = null;
    }
    isRecording = false;
    shortcutDisplay.classList.remove('recording');
    setShortcutBtn.textContent = '设置';
    resetShortcutBtn.style.display = '';
  }

  setShortcutBtn.addEventListener('click', () => {
    if (isRecording) {
      // 取消录制
      chrome.storage.local.get(['skipShortcut'], result => {
        shortcutDisplay.textContent = result.skipShortcut ? formatShortcut(result.skipShortcut) : '未设置';
      });
      stopRecording();
      return;
    }

    isRecording = true;
    shortcutDisplay.textContent = '请按下快捷键...';
    shortcutDisplay.classList.add('recording');
    setShortcutBtn.textContent = '取消';
    resetShortcutBtn.style.display = 'none';

    recordingListener = (e) => {
      e.preventDefault();
      // 忽略单独的修饰键
      if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
           'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'].includes(e.code)) {
        return;
      }

      const shortcut = {
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey
      };

      chrome.storage.local.set({ skipShortcut: shortcut }, () => {
        shortcutDisplay.textContent = formatShortcut(shortcut);
        stopRecording();
      });
    };

    document.addEventListener('keydown', recordingListener);
  });

  resetShortcutBtn.addEventListener('click', () => {
    if (isRecording) stopRecording();
    chrome.storage.local.remove('skipShortcut', () => {
      shortcutDisplay.textContent = '未设置';
    });
  });
});
