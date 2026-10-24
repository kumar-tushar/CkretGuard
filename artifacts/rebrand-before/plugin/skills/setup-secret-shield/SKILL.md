---
name: setup-secret-shield
description: Use when the user wants to install or evaluate SecretShield's Chrome extension and local prompt composer for ChatGPT and Claude, or understand its current secret-masking coverage.
---

# Set up SecretShield

This is a setup companion. Installing this plugin alone does **not** intercept prompts. The bundled Chrome extension performs local pattern detection and gates recognized website send controls. It does not protect native ChatGPT, Codex, Claude desktop, Claude Code, files, images, voice, history, or arbitrary agent traffic.

Never ask the user to paste real credentials into chat, a tool argument, an issue, or a test. An LLM-based “scan my prompt” workflow would expose those values before redaction. Never claim this plugin can mask a message already submitted to the model. If a user has already shared a real key, avoid repeating it and recommend revoking/rotating it through the issuer.

## Install the browser component

The complete built extension is in `extension/` beside this SKILL.md. Read its `manifest.json` to verify the package version and supported origins. It is self-contained and requires no build or server.

In a local execution environment, locate this skill's `extension` directory and give the user its absolute path. Explain these steps:

1. In Chrome, open `chrome://extensions` and enable Developer mode.
2. Choose Load unpacked and select that directory.
3. Pin SecretShield and reload existing ChatGPT/Claude browser tabs.
4. Open SecretShield's local composer, mask text there, review it, and copy the masked result into the website.

If the host cannot expose local package files, explain that the browser extension must be downloaded/extracted onto the user's computer using a host-supported file delivery mechanism. Do not invent a download URL, claim installation, or copy the package to a cloud scanner. The extension is not automatically installed in Chrome by installing this AI plugin.

Do not modify browser profiles, install extensions, change site access, or alter organization policy as part of explaining setup unless the user explicitly requests those steps and the host supports them.

## Verify with synthetic data

Use `api_key = fictional-credential-123`. The local composer should return `api_key = [REDACTED]`. Never substitute a real credential. On recognized chat inputs, the first secret-bearing send should be canceled and masked for review; a second send is required. Block mode cancels sending until the user removes the secret.

For a provider-free test, prefer the local composer. Sending even a synthetic prompt to an external AI chat requires the user's explicit instruction. Report browser installation and active coverage only after observing them.

## Explain limits accurately

Browser pages can read raw text typed into their own inputs before sending. The local composer avoids placing that text in the website. Detection is pattern-based, not exhaustive; arbitrary unlabeled client IDs and encoded/split secrets may be missed. A client ID is not always confidential, so named client ID protection is configurable. Known placeholders are skipped.

The content-script guard covers only recognized input/send event paths and can be bypassed by changed UI, page scripts, other extensions, disabled or restricted site access, and unsupported sources. It is not a network interception layer or a tamper-proof enterprise control.

Only policy preferences are stored; there is no backend, telemetry, raw prompt logging, or secret vault. Custom sensitive names are literal labels, not secret values. Read [enterprise guidance](references/ENTERPRISE.md) for policy and production-readiness requirements. This build is an engineering pilot; do not describe it as audited, certified, enterprise-complete, or universally compatible.
