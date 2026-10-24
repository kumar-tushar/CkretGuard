(() => {
  'use strict';
  const { getAdapter, getEditors, isVisible, readEditor, writeEditor } = SecretShieldAdapters;
  const adapter = getAdapter(location.hostname);
  if (!adapter) return;
  const fontFamily = '"OpenAI Sans", "OpenAI Sans Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  let policy = null, policyError = false, generation = 0;
  let suppressClick = null, suppressEnter = false;
  let notice = null, pendingNotice = '';
  let review = null, approval = null, pendingSend = null;

  function show(message) {
    pendingNotice = message;
    if (!document.body) return;
    if (!notice?.isConnected) {
      const host = document.createElement('div');
      host.id = 'secret-shield-notice';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `:host{all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;max-width:min(390px,calc(100vw - 40px))}div{font:13px/1.5 ${fontFamily};color:#dfdfdf;background:#181818;border:1px solid #414141;border-radius:12px;padding:14px 18px;box-shadow:0 8px 30px #0003;white-space:pre-wrap}`;
      const text = document.createElement('div');
      text.setAttribute('role', 'status');
      text.setAttribute('aria-live', 'polite');
      shadow.append(style, text);
      document.body.append(host);
      notice = host;
      notice.update = value => { text.textContent = `Ckretguard · ${value}`; };
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

  function closeReview(focus = true) {
    const previous = review;
    review = null;
    if (!previous) return;
    previous.dialog.close();
    previous.host.remove();
    if (focus && previous.editor.isConnected) previous.editor.focus();
  }

  function reviewIsCurrent(current) {
    const editors = getEditors(adapter);
    return review === current && policy && current.generation === generation &&
      current.editor.isConnected && readEditor(current.editor) === current.text &&
      editors.length === 1 && editors[0] === current.editor;
  }

  function submitDraft(current, original) {
    const editors = getEditors(adapter);
    if (!policy || current.generation !== generation || editors.length !== 1 ||
        editors[0] !== current.editor || readEditor(current.editor) !== current.text ||
        (original ? policy.mode === 'block' : pendingSend !== current || SecretShieldCore.scan(current.text, policy).length)) {
      throw new Error('Draft or policy changed');
    }
    const form = current.editor.closest('form');
    const buttons = [...document.querySelectorAll(adapter.send)].filter(button =>
      isVisible(button) && (!form || form.contains(button) || button.form === form));
    if (buttons.length > 1 || (original && buttons.length === 0 && !(form instanceof HTMLFormElement))) {
      throw new Error('Send control unavailable');
    }
    if (!original && buttons.length === 0) return false;
    if (buttons.length === 1 && (buttons[0].disabled || buttons[0].getAttribute('aria-disabled') === 'true')) return false;
    // Approval is bound to this unchanged draft and this synchronous send gesture.
    approval = { editor: current.editor, text: current.text, generation, original,
      clicked: false, submitted: false };
    try {
      if (buttons.length === 1) buttons[0].click();
      else form.requestSubmit();
    } finally { approval = null; }
    return true;
  }

  function releaseOriginal(current) {
    if (review !== current) return;
    try {
      if (!reviewIsCurrent(current) || policy.mode === 'block') {
        closeReview();
        show('The draft or policy changed. Send again to review the current prompt.');
        return;
      }
      closeReview(false);
      if (!submitDraft(current, true)) show('Send is not ready. Your draft is still in the input box.');
    } catch {
      approval = null;
      closeReview();
      show('Could not activate Send. Your draft is still in the input box.');
    }
  }

  function openReview(editor, text, count) {
    if (review?.editor === editor && review.text === text && review.generation === generation) return;
    closeReview(false);
    pendingSend = null;
    const host = document.createElement('div');
    host.id = 'ckretguard-review';
    host.setAttribute('data-ckretguard-review', '');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial;color-scheme:dark}
      dialog{box-sizing:border-box;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;border:1px solid #414141;border-radius:16px;padding:26px;background:#181818;color:#dfdfdf;box-shadow:0 24px 90px #0008;font:14px/1.6 ${fontFamily}}
      dialog::backdrop{background:#000000b8}
      .brand{color:#45d6c8;font-size:10px;font-weight:500;letter-spacing:1.7px;text-transform:uppercase;white-space:pre-wrap}
      h2{font-size:23px;line-height:1.25;letter-spacing:-.6px;margin:14px 0 12px}
      p{margin:10px 0;color:#bcbcbc}p.policy{font-size:12px}
      .actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:24px}
      button{flex:1;min-width:90px;border:1px solid #6b6b6b;border-radius:8px;padding:11px 16px;background:#303030;color:#dfdfdf;font:600 13px ${fontFamily};cursor:pointer}
      button:focus-visible{outline:2px solid #dfdfdf;outline-offset:3px}
      button.mask{background:#339cff;color:#0d0d0d;border-color:#339cff}
      button.send{border-color:#d43b45;color:#fff;background:#b4232d}
      button:disabled{opacity:.45;cursor:not-allowed}
    `;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'ckretguard-review-title');
    dialog.setAttribute('aria-describedby', 'ckretguard-review-description');
    dialog.innerHTML = '<div class="brand">CKRETGUARD ·  ORENTHIC</div><h2 id="ckretguard-review-title">Secrets detected</h2><p id="ckretguard-review-description"></p><div class="actions"><button type="button" class="send">Send</button><button type="button" class="edit" autofocus>Edit</button><button type="button" class="mask">Mask</button></div>';
    dialog.querySelector('#ckretguard-review-description').textContent =
      `${count} secret${count === 1 ? '' : 's'} detected in this prompt.`;
    const send = dialog.querySelector('.send');
    send.disabled = policy.mode === 'block';
    if (send.disabled) {
      const explanation = document.createElement('p');
      explanation.className = 'policy';
      explanation.textContent = 'Block mode prevents sending original credentials. Choose Edit or Mask.';
      dialog.querySelector('.actions').before(explanation);
    }
    const current = { host, dialog, editor, text, generation };
    review = current;
    send.addEventListener('click', () => releaseOriginal(current));
    dialog.querySelector('.edit').addEventListener('click', () => { if (review === current) closeReview(); });
    dialog.querySelector('.mask').addEventListener('click', async () => {
      let masked;
      try {
        if (!reviewIsCurrent(current)) {
          if (review === current) closeReview();
          show('The draft or policy changed. Send again to review the current prompt.');
          return;
        }
        const result = SecretShieldCore.redact(current.text, policy);
        closeReview(false);
        writeEditor(editor, result.text);
        masked = { editor, text: result.text, generation: current.generation };
        pendingSend = masked;
        // Let the host editor process input, then use its current enabled Send control.
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          if (submitDraft(masked, false)) return;
        }
        show('The masked draft is ready, but Send is unavailable. It has not been sent.');
      } catch {
        if (review === current) closeReview();
        show('Could not send the masked prompt. Check the draft and send again.');
      } finally { if (pendingSend === masked) pendingSend = null; }
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (review === current) closeReview(); });
    shadow.append(style, dialog);
    (document.body ?? document.documentElement).append(host);
    dialog.showModal();
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
      const text = readEditor(editor);
      if (approval && approval.editor === editor && approval.text === text &&
          approval.generation === generation && (!approval.original || policy.mode !== 'block')) {
        if (event.type === 'click' && !approval.clicked) { approval.clicked = true; return false; }
        if (event.type === 'submit' && !approval.submitted) { approval.submitted = true; return false; }
      }
      if (pendingSend?.editor === editor) { stop(event); return true; }
      const result = SecretShieldCore.redact(text, policy);
      if (!result.count) return false;
      stop(event);
      openReview(editor, text, result.count);
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
    if (suppressClick === button && !approval) { suppressClick = null; stop(event); return; }
    guard(event, getEditors(adapter));
  }, true);
  window.addEventListener('submit', event => {
    if (event.target instanceof Element &&
        (event.target.querySelector(adapter.editors) || event.target.querySelector(adapter.send))) {
      guard(event, getEditors(adapter));
    }
  }, true);
  window.addEventListener('input', event => {
    const editor = editorFrom(event.target);
    if (editor && review?.editor === editor && readEditor(editor) !== review.text) closeReview(false);
    if (editor && approval?.editor === editor && readEditor(editor) !== approval.text) approval = null;
    if (editor && pendingSend?.editor === editor && readEditor(editor) !== pendingSend.text) pendingSend = null;
  }, true);

  async function refreshPolicy() {
    const request = ++generation;
    policy = null;
    approval = null;
    pendingSend = null;
    closeReview(false);
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
