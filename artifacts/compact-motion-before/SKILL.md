---
name: setup-secret-shield
description: Use when the user wants to install or evaluate Ckretguard's Chrome extension and local prompt composer for ChatGPT and Claude, or understand its current secret-masking coverage.
---

# Set up Ckretguard

Ckretguard is published by Orenthic.

This is a setup companion. Installing this plugin alone does **not** intercept prompts. The bundled Chrome extension performs local pattern detection and gates recognized website send controls. It does not protect native ChatGPT, Codex, Claude desktop, Claude Code, files, images, voice, history, or arbitrary agent traffic.

Never ask the user to paste real credentials into chat, a tool argument, an issue, or a test. An LLM-based “scan my prompt” workflow would expose those values before redaction. Never claim this plugin can mask a message already submitted to the model. If a user has already shared a real key, avoid repeating it and recommend revoking/rotating it through the issuer.

## Install the browser component

The complete built extension is in `extension/` beside this SKILL.md. Read its `manifest.json` to verify the package version and supported origins. It is self-contained and requires no build or server.

In a local execution environment, locate this skill's `extension` directory and give the user its absolute path. Explain these steps:

1. In Chrome, open `chrome://extensions` and enable Developer mode.
2. Choose Load unpacked and select that directory.
3. Pin Ckretguard and reload existing ChatGPT/Claude browser tabs.
4. Open Ckretguard's local composer, mask text there, review it, and copy the masked result into the website.

If the host cannot expose local package files, explain that the browser extension must be downloaded/extracted onto the user's computer using a host-supported file delivery mechanism. Do not invent a download URL, claim installation, or copy the package to a cloud scanner. The extension is not automatically installed in Chrome by installing this AI plugin.

Do not modify browser profiles, install extensions, change site access, or alter organization policy as part of explaining setup unless the user explicitly requests those steps and the host supports them.

## Verify with synthetic data

Use `api_key = fictional-credential-123`. The local composer should return `api_key = xxxxx`; masking, review, and copying remain manual, and the composer never sends a prompt. Never substitute a real credential. On recognized chat inputs, clicking Send or pressing Enter with this draft should cancel the send and open a **Secrets detected** warning showing “1 secret detected in this prompt.” and **Send**, **Edit**, and **Mask**. **Send** sends the unchanged draft for that one attempt. **Edit** sends nothing and focuses the unchanged draft. **Mask** replaces detected credential values with `xxxxx` and automatically sends the masked prompt once after a successful re-scan and revalidation of the current draft and policy. No second click is needed. Block mode disables **Send** while retaining **Edit** and **Mask** under the same validation requirements. Pasting the example alone should not modify it; detection occurs at submission. The displayed count is the detected occurrence count, not confirmed leaks or a guarantee that every secret was found.

For a provider-free test, prefer the local composer. Sending even a synthetic prompt to an external AI chat requires the user's explicit instruction. Report browser installation and active coverage only after observing them.

## Explain limits accurately

Browser pages can read raw text typed into their own inputs before sending. The local composer avoids placing that text in the website. Detection targets credentials such as keys, passwords, client IDs, client secrets, tokens, and private keys; it does not classify general confidential prose. Detection is pattern-based, not exhaustive; arbitrary unlabeled client IDs and encoded/split secrets may be missed. A client ID is not always confidential, so named client ID protection is configurable. Known placeholders are skipped. Scan and policy failures block recognized sending and cannot be bypassed with the **Send** choice.

The content-script guard covers only recognized input/send event paths and can be bypassed by changed UI, page scripts, other extensions, disabled or restricted site access, and unsupported sources. It is not a network interception layer or a tamper-proof enterprise control.

Only policy preferences are stored; there is no backend, telemetry, raw prompt logging, or secret vault. Custom sensitive names are literal labels, not secret values. Read [enterprise guidance](references/ENTERPRISE.md) for policy and production-readiness requirements. This build is an engineering pilot; do not describe it as audited, certified, enterprise-complete, or universally compatible.
