(() => {
  'use strict';
  // Narrow selectors intentionally avoid unrelated fields, search, and login forms.
  const adapters = {
    'chatgpt.com': {
      name: 'ChatGPT',
      editors: '#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][role="textbox"][data-composer-markdown]',
      send: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]',
    },
    'claude.ai': {
      name: 'Claude',
      editors: '[contenteditable="true"][data-testid="chat-input"], [contenteditable="true"][data-placeholder], fieldset [contenteditable="true"].ProseMirror, [contenteditable="true"].tiptap',
      send: 'button[aria-label="Send message"], button[data-testid="send-button"]',
    },
  };
  adapters['chat.openai.com'] = adapters['chatgpt.com'];
  function getAdapter(hostname) { return adapters[hostname] ?? null; }
  function isVisible(element) {
    return element.isConnected && element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]');
  }
  function getEditors(adapter) {
    return [...document.querySelectorAll(adapter.editors)].filter(isVisible);
  }
  function readEditor(editor) {
    return editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
  }
  function writeEditor(editor, text) {
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text);
    } else {
      // Use the editor's editing transaction where available (ProseMirror/React state).
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand('insertText', false, text)) editor.textContent = text;
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
    if (readEditor(editor) !== text) throw new Error('Editor update failed');
  }
  globalThis.SecretShieldAdapters = Object.freeze({ getAdapter, getEditors, isVisible, readEditor, writeEditor });
})();
