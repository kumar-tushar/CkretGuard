(() => {
  'use strict';
  const { getAdapter, getEditors, isVisible, readEditor, writeEditor } = SecretShieldAdapters;
  const adapter = getAdapter(location.hostname);
  if (!adapter) return;
  const fontFamily = '"CkretGuard DM Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const noticeDuration = 5000;
  let policy = null, policyError = false, generation = 0;
  let suppressClick = null, suppressEnter = false;
  let notice = null, noticeTimer = null, pendingNotice = '';
  let review = null, approval = null, pendingSend = null;

  function show(message) {
    pendingNotice = message;
    if (!document.body) return;
    pendingNotice = '';
    clearTimeout(noticeTimer);
    if (!notice?.isConnected) {
      const host = document.createElement('div');
      host.id = 'secret-shield-notice';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `:host{all:initial;position:fixed;bottom:40px;right:20px;z-index:2147483647;max-width:min(390px,calc(100vw - 40px))}div{position:relative;overflow:hidden;display:flex;align-items:flex-start;gap:10px;font:13px/1.5 ${fontFamily};color:#dfdfdf;background:rgb(24 24 24 / .55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border:1px solid #ffffff28;border-radius:12px;padding:14px 18px;box-shadow:0 8px 30px #0003;white-space:pre-wrap}strong{color:#45d6c8;font-weight:500}.brand-icon{flex:0 0 20px;width:20px;height:20px;background:#45d6c8;mask:url("${chrome.runtime.getURL('icons/orbit-pointer.png')}") center/contain no-repeat}.notice-progress{position:absolute;top:0;left:0;width:100%;height:3px;background:#45d6c8;transform-origin:left;pointer-events:none}`;
      const text = document.createElement('div');
      text.setAttribute('role', 'status');
      text.setAttribute('aria-live', 'polite');
      const icon = document.createElement('span');
      icon.className = 'brand-icon';
      icon.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span');
      const brand = document.createElement('strong');
      brand.textContent = 'CkretGuard';
      const body = document.createElement('span');
      const progress = document.createElement('span');
      progress.className = 'notice-progress';
      progress.setAttribute('aria-hidden', 'true');
      copy.append(brand, ' · ', body);
      text.append(progress, icon, copy);
      shadow.append(style, text);
      document.body.append(host);
      notice = host;
      notice.update = value => {
        body.textContent = value;
        progress.getAnimations().forEach(animation => animation.cancel());
        progress.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
          { duration: noticeDuration, easing: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'steps(5, end)' : 'linear', fill: 'forwards' });
      };
    }
    notice.update(message);
    const currentNotice = notice;
    noticeTimer = setTimeout(() => {
      currentNotice.remove();
      if (notice === currentNotice) { notice = null; noticeTimer = null; }
    }, noticeDuration);
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
    previous.dialog.getAnimations().forEach(animation => animation.cancel());
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

  async function animateDismiss(current, direction) {
    if (review !== current || current.closing) return false;
    current.closing = true;
    current.dialog.querySelectorAll('button').forEach(button => { button.disabled = true; });
    current.dialog.dataset.motion = direction;
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const computed = getComputedStyle(current.dialog);
      const start = { transform: computed.transform, opacity: computed.opacity };
      current.dialog.getAnimations().forEach(animation => animation.cancel());
      const end = direction === 'down' ? 'calc(50vh + 100%)' : 'calc(-50vh - 100%)';
      const animation = current.dialog.animate([start, { transform: `translateY(${end})`, opacity: 0 }],
        { duration: 180, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
      await animation.finished.catch(() => {});
    }
    return review === current;
  }

  function submitDraft(current, original) {
    const editors = getEditors(adapter);
    if (!policy || current.generation !== generation || editors.length !== 1 ||
        editors[0] !== current.editor || readEditor(current.editor) !== current.text ||
        (original ? policy.mode === 'block' : pendingSend !== current || SecretShieldCore.scan(current.text, policy, current.text.length).length)) {
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

  async function releaseOriginal(current) {
    if (review !== current || current.closing) return;
    try {
      if (!reviewIsCurrent(current) || policy.mode === 'block') {
        closeReview();
        show('The draft or policy changed. Send again to review the current prompt.');
        return;
      }
      if (!await animateDismiss(current, 'up')) return;
      if (!reviewIsCurrent(current) || policy.mode === 'block') {
        if (review === current) closeReview();
        show('The draft or policy changed. Send again to review the current prompt.');
        return;
      }
      closeReview(false);
      if (submitDraft(current, true)) void globalThis.SecretShieldStats?.record('unmaskedPrompts');
      else show('Send is not ready. Your draft is still in the input box.');
    } catch {
      approval = null;
      if (review === current) closeReview();
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
      dialog{box-sizing:border-box;width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;border:1px solid #ffffff28;border-radius:16px;padding:26px;background:rgb(24 24 24 / .55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:#dfdfdf;box-shadow:0 24px 70px #0006;font:14px/1.6 ${fontFamily}}
      dialog::backdrop{background:#0003}
      .brand-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .brand{color:#45d6c8;font-size:12px;font-weight:500;letter-spacing:1.7px;white-space:pre-wrap}
      .brand-icon{display:block;flex:0 0 24px;width:24px;height:24px;background:#45d6c8;mask:url("${chrome.runtime.getURL('icons/orbit-pointer.png')}") center/contain no-repeat}
      h2{font-size:20px;line-height:1.25;letter-spacing:-.6px;margin:20px 0 12px}
      .count{color:#ff6b6b}
      .actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:28px}
      button{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:1;min-width:90px;box-sizing:border-box;height:34px;border:0;outline:none;box-shadow:none;border-radius:999px;padding:0 16px;background:#303030;color:#dfdfdf;font:500 13px ${fontFamily};cursor:pointer}
      .button-icon{width:14px;height:14px;flex:0 0 14px;pointer-events:none}
      button:focus-visible{filter:brightness(1.2)}
      button.mask{background:#1f6fc7;color:#fff}
      button.mask:hover:enabled{background:#45d6c8;color:#181818}
      button.send{color:#fff;background:#b4232d}
      button:disabled{opacity:.45;cursor:not-allowed}
    `;
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-labelledby', 'ckretguard-review-title');
    dialog.innerHTML = '<div class="brand-row"><div class="brand">CkretGuard ·  ORENTHIC</div><span class="brand-icon" aria-hidden="true"></span></div><h2 id="ckretguard-review-title"><span class="count"></span> <span class="caption"></span></h2><div class="actions"><button type="button" class="send">Send</button><button type="button" class="edit" autofocus>Edit</button><button type="button" class="mask">Mask</button></div>';
    const actionIcons = {
      send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
      edit: '<path d="m16 3 5 5-13 13H3v-5Z"/><path d="m14 5 5 5"/>',
      mask: '<path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 10 8 10 8a15 15 0 0 1-3 4.2M6.6 6.6C3.6 8.5 2 12 2 12s3 8 10 8a10.8 10.8 0 0 0 5.4-1.4"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8M3 3l18 18"/>',
    };
    for (const [action, paths] of Object.entries(actionIcons)) {
      dialog.querySelector(`.${action}`).insertAdjacentHTML('afterbegin', `<svg class="button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`);
    }
    dialog.querySelector('.count').textContent = String(count);
    dialog.querySelector('.caption').textContent = `${count === 1 ? 'secret' : 'secrets'} detected`;
    const send = dialog.querySelector('.send');
    if (policy.mode === 'block') send.remove();
    const current = { host, dialog, editor, text, generation, closing: false };
    review = current;
    if (policy.mode !== 'block') send.addEventListener('click', () => releaseOriginal(current));
    dialog.querySelector('.edit').addEventListener('click', async () => {
      if (await animateDismiss(current, 'down')) closeReview();
    });
    dialog.querySelector('.mask').addEventListener('click', async () => {
      let masked;
      try {
        if (review !== current || current.closing) return;
        if (!reviewIsCurrent(current)) {
          closeReview();
          show('The draft or policy changed. Send again to review the current prompt.');
          return;
        }
        if (!await animateDismiss(current, 'up')) return;
        if (!reviewIsCurrent(current)) {
          if (review === current) closeReview();
          show('The draft or policy changed. Send again to review the current prompt.');
          return;
        }
        const result = SecretShieldCore.redact(current.text, policy, current.text.length);
        closeReview(false);
        writeEditor(editor, result.text);
        masked = { editor, text: result.text, generation: current.generation };
        pendingSend = masked;
        // Let the host editor process input, then use its current enabled Send control.
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          if (submitDraft(masked, false)) {
            void globalThis.SecretShieldStats?.record('maskedPrompts');
            return;
          }
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
    void globalThis.SecretShieldStats?.record('detected', count);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog.animate([{ transform: 'translateY(calc(50vh + 100%))', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 }],
        { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
  }

  function guard(event, editors) {
    if (denyUnavailable(event)) return true;
    if (editors.length !== 1) {
      stop(event);
      show('Chat input could not be identified uniquely. Reload the chat tab before sending.');
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
      const result = SecretShieldCore.redact(text, policy, text.length);
      if (!result.count) return false;
      stop(event);
      openReview(editor, text, result.count);
      return true;
    } catch {
      stop(event);
      show('Could not scan or update this input. Send blocked. Shorten the draft or reload the chat tab.');
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
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed' || (area === 'local' && Object.hasOwn(changes, 'policy'))) void refreshPolicy();
  });
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== 'coverage') return;
    reply({ site: adapter.name, ready: Boolean(policy), error: policyError, editors: getEditors(adapter).length });
  });
  document.addEventListener('DOMContentLoaded', () => { if (pendingNotice) show(pendingNotice); }, { once: true });
  void refreshPolicy();
})();
