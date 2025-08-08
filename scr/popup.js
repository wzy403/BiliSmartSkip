document.addEventListener('DOMContentLoaded', () => {
  const switchInput = document.getElementById('modeSwitch');
  const modeText = document.getElementById('modeText');

  // 初始化状态
  chrome.storage.local.get(['skipMode'], result => {
    const currentMode = result.skipMode || 'manual';
    switchInput.checked = currentMode === 'auto';
    updateText(currentMode);
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
});
