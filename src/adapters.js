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
    return element.isConnected && element.getClientRects().length > 0 &&
      !element.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(element).visibility === 'visible';
  }
  function getEditors(adapter) {
    return [...document.querySelectorAll(adapter.editors)].filter(isVisible);
  }
  function readEditor(editor) {
    return editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText;
  }
  function editorPoint(editor, text, offset) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let cursor = 0;
    for (let node; node = walker.nextNode();) {
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!node.data || !range.getClientRects().length || getComputedStyle(node.parentElement).visibility !== 'visible') continue;
      const start = text.indexOf(node.data, cursor);
      if (start < 0 && !node.data.trim()) continue;
      if (start < 0 || /\S/.test(text.slice(cursor, start))) throw new Error('Editor text could not be mapped');
      const end = start + node.length;
      if (offset >= start && offset <= end) return { node, offset: offset - start };
      cursor = end;
    }
    throw new Error('Editor text could not be mapped');
  }
  function writeEditor(editor, text, findings) {
    if (editor instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text);
    } else {
      // Use the editor's editing transaction where available (ProseMirror/React state).
      editor.focus();
      const selection = window.getSelection();
      if (findings?.length) {
        // Replace values from the end so earlier offsets and paragraph boundaries stay intact.
        let current = readEditor(editor);
        for (const finding of [...findings].reverse()) {
          const start = editorPoint(editor, current, finding.start);
          const end = editorPoint(editor, current, finding.end);
          const range = document.createRange();
          range.setStart(start.node, start.offset);
          range.setEnd(end.node, end.offset);
          selection.removeAllRanges();
          selection.addRange(range);
          const expected = current.slice(0, finding.start) + SecretShieldCore.MASK + current.slice(finding.end);
          if (!document.execCommand('insertText', false, SecretShieldCore.MASK) || readEditor(editor) !== expected) throw new Error('Editor update failed');
          current = expected;
        }
        if (current !== text) throw new Error('Editor update failed');
      } else {
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand('insertText', false, text)) editor.textContent = text;
      }
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
    if (readEditor(editor) !== text) throw new Error('Editor update failed');
  }
  globalThis.SecretShieldAdapters = Object.freeze({ getAdapter, getEditors, isVisible, readEditor, writeEditor });
})();
