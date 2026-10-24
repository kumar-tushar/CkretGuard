# CkretGuard

Published by **Orenthic**.

Local credential detection and masking for **ChatGPT and Claude in Chrome**. Version 1.0.0 is an engineering pilot, not a production-certified enterprise DLP product.

CkretGuard runs a deterministic scanner on your device. It detects common API keys, private keys, bearer/basic credentials, JWTs, connection-string passwords, and labeled credentials (`api_key`, `password`, `client_secret`, `client_id`, and similar names). Additional literal field names can be configured. Client IDs are not always confidential; their protection is enabled by default and configurable. Detection targets credentials, rather than general personal or confidential prose. Built-in multiword field names accept joined/camelCase, spaces or tabs, hyphens, and underscores, including repeated or mixed separators, regardless of capitalization. For example, `apiToken`, `api-token`, `api token`, and `api_token` all match. The same rule covers client secrets, access/auth/refresh tokens, secret/private keys, AWS field names, and client IDs when enabled. Field-to-value separators accept `=`, `:`, `is`, and fullwidth `＝`/`：`; a value may follow on the next line. Straight or curly quotes and Markdown backticks preserve values containing spaces, including a quote left open at the end of a line. Backticks around field labels and fenced credential values are supported. Nonbreaking horizontal spaces are accepted. Complete variable placeholders such as `${SERVICE_KEY}` remain unchanged, and Authorization schemes are excluded from the credential count. Unquoted values end at whitespace; quote values containing spaces. Bearer and Basic tokens accept quotes or backticks and may wrap onto subsequent lines. Incomplete labeled authorization schemes block sending rather than masking only the scheme. Custom field names remain literal apart from capitalization.

## Try it

Build the extension into `dist/` with Node.js **24 LTS**. `.nvmrc` selects Node 24, and npm rejects other major versions. If you use nvm, run `nvm install` and `nvm use` first:

```sh
npm ci
npm run build
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select this project's `dist` folder.
3. Pin CkretGuard and reload existing ChatGPT / Claude tabs.
4. Open the extension and expand **Custom secret fields**. Enter a field name such as `dataset_key` and choose **Save**. Saved names appear below the count, one per row, with a remove button on the right. At 50 fields, the input is hidden until a field is removed. For example, adding `dataset1` protects values assigned to that field.

In recognized website inputs, clicking Send or pressing Enter scans the draft. If credentials are detected, the original send is canceled and a single headline shows the exact detected occurrence count (for example, “2 secrets detected”). The number is red. The dialog provides three choices:

- **Send** sends the original draft unchanged for this one attempt.
- **Edit** sends nothing and returns focus to the unchanged draft.
- **Mask** replaces detected credential values with `xxxxx` and automatically sends the masked prompt once after rechecking the draft and policy. No second click is needed.

Pasting text leaves it unchanged; detection happens when you try to send. Plain messages use the website's normal send behavior. The **Edit or Mask** setting (`block` mode) removes **Send** from the popup; only **Edit** and **Mask** are shown. The **Send, Edit, or Mask** setting (`redact` mode) shows all three actions. Selecting a mode or changing client-ID protection saves immediately.

The count describes detected occurrences, not confirmed leaks or a guarantee that every secret was found.

The toolbar dashboard shows three local totals: **Detected** counts secret occurrences across new chat reviews; **Masked Sent** counts prompts forwarded after choosing Mask; **Unmasked Sent** counts prompts forwarded unchanged after choosing Send. Each completed sending action adds one prompt, regardless of its number of secrets. An unsent masked draft does not count as sending. Repeated reviews or sending attempts count again. These are action totals, not unique keys or provider delivery receipts. Existing detection totals are retained, including historical local scans; legacy masked/sent secret totals cannot be converted to prompt totals.

Use the **settings icon** at the top right to open full mode and use the **Home**, **History**, **Privacy Policy**, and **Contact Us** sidebar. History saves the complete original prompt, including secrets, only after the review's **Send** choice activates the website's send control. Each entry includes its time, chat site, detected count, and conversation link when available. Entries from the last 90 days appear newest first; expand one to inspect the prompt and rotate any exposed credentials. Older entries are deleted automatically on History access, on extension worker startup, and during hourly cleanup while Chrome is running. Delete entries individually or clear History without resetting the activity totals. Masked prompts, ordinary messages, edited drafts, and cancelled or unavailable sends are not recorded. History starts with this update and cannot recover earlier prompts. It records submission attempts, not provider delivery confirmations.

For a synthetic custom-field example, save `dataset1` in the extension, then enter `dataset1 = fictional-value-123` into a supported chat input. Sending opens the review popup. **Mask** sends `dataset1 = xxxxx`. Clicking × beside a saved name removes that custom field; built-in credential detection remains active. Up to 50 names can be saved, with newly added names requiring 3–64 characters, starting with a letter and containing letters, digits, spaces, underscores or hyphens. Names match case-insensitively with `=`, `:`, or `is` assignments, including quoted JSON fields. Bare field names and unrelated unlabeled values do not trigger this rule. Never test with a real credential.

**The Chrome extension performs the interception.** The optional CkretGuard AI plugin is a setup companion containing the extension and its instructions. Enabling that plugin alone does not intercept prompts in ChatGPT, Codex, Claude, or other clients.

## Privacy and coverage

- No backend, remote scanner, remote analytics, remote scripts, or model calls. Policy preferences and three aggregate numeric counters use Chrome local storage. Unmasked-send History uses a separate extension-origin IndexedDB database and contains full prompts with their secret values, timestamps, and supported chat links. It is not encrypted by CkretGuard or synced/uploaded. Entries older than 90 days are deleted automatically; earlier deletion, extension data removal, and browser storage limits also apply. A storage failure shows a notice rather than silently discarding or truncating the prompt. Clearing History does not remove messages from the chat provider. Nothing is placed in sync storage. Extension pages have `connect-src 'none'`.
- Website guards operate on recognized inputs and send controls on `chatgpt.com`, `chat.openai.com`, and `claude.ai`. Popup coverage reports whether an input is recognized, not a proof that every transmission is protected.
- A website can read text as you type into its own page, including autosave/telemetry, before you press Send. Custom fields store names rather than sample secret values. The toolbar does not provide a private prompt composer.
- This version does not intercept network requests. It cannot enforce confidentiality against a hostile site, scripts using programmatic requests, changed or unknown UI controls, browser extensions, compromised devices, or disabled/site-restricted installation. Site DOM changes can bypass event coverage; reload the tab and verify recognition before relying on the guard.
- Files, images, voice, drag-and-drop, rich-text metadata, conversation history, tool output, API traffic, native desktop apps, Codex, and Claude Code are outside browser-guard coverage. There is no claim to protect every AI agent.
- Detection is pattern-based: arbitrary unlabeled values, misspelled field names, separator-free phrases, grouped field-name lists with separate unlabeled value lines, encoded/obfuscated secrets, and some uncommon formats may be missed. False positives are possible. Known placeholders are skipped. Custom field names are literal labels, not regex or secret-value storage.
- Browser scans cover the complete current prompt, including drafts above 100,000 characters, without truncating it or changing the chat input’s limits. The standalone scanner and stdin filter retain their 100,000-character default; browser calls explicitly use the full draft length. Excessive scan work, unreadable policy, and failed editor updates block recognized submission paths. The **Send** choice applies to a successfully scanned draft with detected credentials; it does not bypass these failures. This is cooperative browser UI protection, not a tamper-proof boundary.

For deployment controls, see [enterprise guidance](docs/ENTERPRISE.md). For component boundaries and expansion to other clients, see [architecture](docs/ARCHITECTURE.md).

## Develop and verify

```sh
npm test                         # scanner, policies, privacy and CLI contracts
npx playwright install --with-deps chromium # once on a new machine
npm run test:browser              # real unpacked extension, routed synthetic sites
npm run check                     # all unit and browser tests
npm run package                   # both suites, Chrome ZIP, companion plugin ZIP, SHA-256 manifest
```

GitHub Actions runs the unit tests and the complete Playwright suite on every push and pull request, with a manual run option. Like AjentGuard, it uses Node from `.nvmrc`, `npm ci`, Playwright's bundled Chromium, and one test worker on Ubuntu. Failure screenshots and error context are available as `playwright-diagnostics` artifacts for seven days.

Browser fixtures resemble the supported textarea and contenteditable editors. Tests observe outgoing fixture POST bodies and cover the review choices: original text is sent only after **Send**, **Edit** preserves the draft without sending, and **Mask** automatically sends only the masked prompt once. No test sends requests to a real AI service or uses real credentials. Passing these fixtures does not verify today's live provider DOM or organization-managed deployment. Manual release checks remain necessary.

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
