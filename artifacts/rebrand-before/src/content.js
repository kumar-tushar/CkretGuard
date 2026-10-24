(() => {
  'use strict';
  const { getAdapter, getEditors, readEditor, writeEditor } = SecretShieldAdapters;
  const adapter = getAdapter(location.hostname);
  if (!adapter) return;
  let policy = null, policyError = false, changing = false, generation = 0;
  let suppressClick = null, suppressEnter = false;
  let notice = null, pendingNotice = '';

  function show(message) {
    pendingNotice = message;
    if (!document.body) return;
    if (!notice?.isConnected) {
      const host = document.createElement('div');
      host.id = 'secret-shield-notice';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;max-width:min(390px,calc(100vw - 40px))}div{font:13px/1.5 system-ui,sans-serif;color:#e7fff8;background:#112722;border:1px solid #438875;border-radius:12px;padding:14px 18px;box-shadow:0 8px 30px #0003;white-space:pre-wrap}';
      const text = document.createElement('div');
      text.setAttribute('role', 'status');
      text.setAttribute('aria-live', 'polite');
      shadow.append(style, text);
      document.body.append(host);
      notice = host;
      notice.update = value => { text.textContent = `SecretShield · ${value}`; };
    }
    notice.update(message);
  }

  function stop(event) { event.preventDefault(); event.stopImmediatePropagation(); }
  function editorFrom(target) {
    return target instanceof Element ? target.closest(adapter.editors) : null;
  }
  function denyUnavailable(event) {
    if (policy) return false;
    stop(event);
    show(policyError ? 'Policy unavailable. Send is paused. Reload the extension and this tab.' : 'Loading local policy. Send is paused; try again shortly.');
    return true;
  }

  function guard(event, editors) {
    if (denyUnavailable(event)) return true;
    if (editors.length !== 1) {
      stop(event);
      show('Chat input could not be identified uniquely. Use the extension’s local composer.');
      return true;
    }
    try {
      const editor = editors[0];
      const result = SecretShieldCore.redact(readEditor(editor), policy);
      if (!result.count) return false;
      // Always cancel this attempt. Framework state may still contain the old prompt.
      stop(event);
      if (policy.mode === 'block') {
        show('Send blocked: possible secrets detected. Remove them or use the local composer.');
      } else {
        changing = true;
        try { writeEditor(editor, result.text); } finally { changing = false; }
        show(`Masked ${result.count} possible secret${result.count === 1 ? '' : 's'}. Review the text, then send again.`);
      }
      return true;
    } catch {
      stop(event);
      show('Could not scan or update this input. Send blocked. Use the local composer.');
      return true;
    }
  }

  window.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    if (suppressEnter && event.repeat) { stop(event); return; }
    const editor = editorFrom(event.target);
    if (editor) suppressEnter = guard(event, [editor]);
  }, true);
  window.addEventListener('keyup', event => {
    if (event.key === 'Enter' && suppressEnter) { stop(event); suppressEnter = false; }
  }, true);
  window.addEventListener('pointerdown', event => {
    const button = event.target instanceof Element ? event.target.closest(adapter.send) : null;
    if (!button) return;
    suppressClick = guard(event, getEditors(adapter)) ? button : null;
  }, true);
  window.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest(adapter.send) : null;
    if (!button) return;
    if (suppressClick === button) { suppressClick = null; stop(event); return; }
    guard(event, getEditors(adapter));
  }, true);
  window.addEventListener('submit', event => {
    if (event.target instanceof Element &&
        (event.target.querySelector(adapter.editors) || event.target.querySelector(adapter.send))) {
      guard(event, getEditors(adapter));
    }
  }, true);
  window.addEventListener('paste', event => {
    const editor = editorFrom(event.target);
    if (!editor || denyUnavailable(event)) return;
    try {
      const text = event.clipboardData?.getData('text/plain');
      if (typeof text !== 'string') { stop(event); show('Paste could not be scanned. Use the local composer.'); return; }
      const result = SecretShieldCore.redact(text, policy);
      if (!result.count) return;
      stop(event);
      if (policy.mode === 'block') { show('Paste blocked: possible secrets detected.'); return; }
      changing = true;
      try {
        if (editor instanceof HTMLTextAreaElement) {
          const start = editor.selectionStart, end = editor.selectionEnd;
          const next = editor.value.slice(0, start) + result.text + editor.value.slice(end);
          writeEditor(editor, next);
          editor.setSelectionRange(start + result.text.length, start + result.text.length);
        } else if (!document.execCommand('insertText', false, result.text)) {
          show('Paste paused: editor update unavailable. Use the local composer.');
          return;
        }
      } finally { changing = false; }
      show(`Masked ${result.count} possible secret${result.count === 1 ? '' : 's'} before paste.`);
    } catch { stop(event); show('Paste could not be scanned. Keep it local and use the local composer.'); }
  }, true);
  window.addEventListener('input', event => {
    const editor = editorFrom(event.target);
    if (!editor || changing || !policy) return;
    try {
      if (SecretShieldCore.scan(readEditor(editor), policy).length) show('Possible secret detected. Sending will be paused for masking.');
    } catch { show('Input exceeds scanner limits. Sending will be blocked.'); }
  }, true);

  async function refreshPolicy() {
    const request = ++generation;
    policy = null;
    try {
      const loaded = await SecretShieldPolicy.loadPolicy();
      if (request === generation) { policy = loaded.policy; policyError = false; }
    } catch {
      if (request === generation) { policyError = true; show('Policy unavailable. Send is paused.'); }
    }
  }
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'managed' || area === 'local') void refreshPolicy();
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'coverage') return;
    reply({ site: adapter.name, ready: Boolean(policy), error: policyError, editors: getEditors(adapter).length });
  });
  document.addEventListener('DOMContentLoaded', () => { if (pendingNotice) show(pendingNotice); }, { once: true });
  void refreshPolicy();
})();
