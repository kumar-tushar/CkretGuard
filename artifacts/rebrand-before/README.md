# SecretShield

Local secret masking for **ChatGPT and Claude in Chrome**. Version 0.1.0 is an engineering pilot, not a production-certified enterprise DLP product.

SecretShield runs a deterministic scanner on your device. It masks common API keys, private keys, bearer/basic credentials, JWTs, connection-string passwords, and labeled credentials (`api_key`, `password`, `client_secret`, `client_id`, and similar names). Additional literal field names can be configured. Client IDs are not always confidential; their protection is enabled by default and configurable.

## Try it

The built extension is in `dist/`. Or build it from source with Node.js 22+:

```sh
npm ci
npm run build
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `dist` folder.
3. Pin SecretShield and reload existing ChatGPT / Claude tabs.
4. Open the extension for the **local composer**. Mask your text, review it, and copy only the masked result into chat.

In recognized website inputs, detected clipboard secrets are masked before the paste is delivered to the page. When sending a prompt with a detected secret, the original send is canceled and the text is masked. Review it and send again. In Block mode, the draft is left intact and sending is canceled until you remove the secret. Plain messages use the website's normal send behavior.

For a synthetic example, type `api_key = fictional-credential-123` into the local composer. The result is `api_key = [REDACTED]`. Never test with a real credential.

**The Chrome extension performs the interception.** The optional SecretShield AI plugin is a setup companion containing the extension and its instructions. Enabling that plugin alone does not intercept prompts in ChatGPT, Codex, Claude, or other clients.

## Privacy and coverage

- No backend, remote scanner, analytics, remote scripts, model calls, prompt history, or secret vault. Only non-secret policy preferences are persisted in Chrome local storage. Nothing is placed in sync storage. Extension pages have `connect-src 'none'`.
- Original text exists temporarily in the local composer while it is open. Clear it explicitly or close the window. Copy uses only the current masked result; original clipboard contents and OS clipboard history are outside this extension's control.
- Website guards operate on recognized inputs and send controls on `chatgpt.com`, `chat.openai.com`, and `claude.ai`. Popup coverage reports whether an input is recognized, not a proof that every transmission is protected.
- A website can read text as you type into its own page, including autosave/telemetry, before you press Send. Use the local composer to avoid entering raw secrets into the page.
- This version does not intercept network requests. It cannot enforce confidentiality against a hostile site, scripts using programmatic requests, changed or unknown UI controls, browser extensions, compromised devices, or disabled/site-restricted installation. Site DOM changes can bypass event coverage; use the local composer when input coverage is unavailable.
- Files, images, voice, drag-and-drop, rich-text metadata, conversation history, tool output, API traffic, native desktop apps, Codex, and Claude Code are outside browser-guard coverage. There is no claim to protect every AI agent.
- Detection is pattern-based: arbitrary unlabeled values, encoded/obfuscated secrets, split secrets, and some uncommon formats may be missed. False positives are possible. Known placeholders are skipped. Custom field names are literal labels, not regex or secret-value storage.
- Inputs over 100,000 UTF-16 characters, excessive scan work, unreadable policy, and failed editor updates block recognized submission paths. There is no “send anyway” switch inside the guard. This is cooperative browser UI protection, not a tamper-proof boundary.

For deployment controls, see [enterprise guidance](docs/ENTERPRISE.md). For component boundaries and expansion to other clients, see [architecture](docs/ARCHITECTURE.md).

## Develop and verify

```sh
npm test                         # scanner, policies, privacy and CLI contracts
npx playwright install chromium  # once on a new machine
npm run test:browser              # real unpacked extension, routed synthetic sites
npm run package                   # both suites, Chrome ZIP, companion plugin ZIP, SHA-256 manifest
```

Browser fixtures resemble the supported textarea and contenteditable editors. Tests observe outgoing fixture POST bodies and verify that a blocked original prompt is never submitted through the tested paths. No test sends requests to a real AI service or uses real credentials. Passing these fixtures does not verify today's live provider DOM or organization-managed deployment. Manual release checks remain necessary.

All browser profiles are temporary. Tests do not use your normal Chrome profile. Screenshots use synthetic data only. Generated artifacts are excluded from Git.

## Use the scanner in another client

The shared JavaScript scanner has no runtime dependencies:

```js
import { redact } from './src/index.mjs';
const result = redact(prompt);
// Send result.text only after the local host has intercepted the original request.
```

Exceptions must block delivery. Never fall back to the original prompt. A local stdin filter is also included:

```sh
node scripts/redact.mjs < prompt.txt > masked.txt
```

Avoid putting credentials in command arguments, chat messages, issue reports, or test fixtures. The filter does not alter or delete the original file. It cannot retroactively remove text already sent to a model.
