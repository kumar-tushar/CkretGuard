# Architecture and trust boundaries

## Browser pilot

`src/core.js` is the shared synchronous scanner. It returns redacted text and finding offsets/types; it never returns a secret-value field. Repeated detected values are masked within that scan without retaining a lookup table between calls. Overlapping findings merge. A fixed `xxxxx` marker avoids exposing the original length or a reversible mapping. The scanner targets credential formats and labeled values such as keys, passwords, client IDs, client secrets, and tokens; it cannot identify every arbitrary unlabeled secret or confidential passage. Text and scan-work limits bound local execution. The scanner makes no network or storage calls. `src/index.mjs` exposes it to other JavaScript hosts.

`src/policy.js` loads local preferences and read-only managed policy. Each configured managed field takes precedence and locks the corresponding local control. Invalid/unreadable policy stops scanning and recognized sending rather than silently reverting to a weaker policy. `sensitiveNames` accepts bounded literal labels and escapes them before use; administrator-provided regexes cannot execute.

`src/adapters.js` limits inspection to documented-in-code editor selectors for the three configured hostnames. It does not traverse arbitrary inputs, passwords, login forms, iframes, shadow DOM, attachments, or chat history. Contenteditable updates use a browser editing transaction when available, then emit input to synchronize the page framework. Fallbacks can flatten rich-text formatting. Masked editor text must be verified and re-scanned before automatic submission.

`src/content.js` is injected at document start in the isolated world. Capture-phase listeners gate recognized Enter, send-button pointer/click, and form submission paths. A secret-bearing attempt is canceled and opens a **Secrets detected** review dialog with an exact detected occurrence count and **Send**, **Edit**, and **Mask** buttons. The dialog has no explanatory paragraph or footer. The count describes detected occurrences, not confirmed leaks or exhaustive coverage. **Send** authorizes the current unchanged draft for one submission attempt under the current policy; **Edit** closes the dialog and focuses the unchanged draft without sending; **Mask** writes the redacted text back to the editor and automatically submits that masked prompt once. Masking requires a successful re-scan and revalidation of the current draft and policy before submission. Block mode disables **Send** while retaining **Edit** and **Mask** under the same validation requirements. Scan/policy failures cannot be overridden through the dialog. Gesture suppression prevents trailing events from duplicating a submission while the dialog opens or the draft is masked. Paste does not scan or change clipboard text; the complete draft is scanned at submission.

`extension/composer.html` is an extension-origin local compose/review surface. It never writes draft text to storage or sends a prompt; masking, review, and copying remain manual. Changing the draft or policy invalidates prior results. Copy re-scans the masked output. The extension page CSP blocks network connections, embedded objects, base-URL changes, and form submission. Source and assets are local; no web-accessible resources are declared.

The content script can still be bypassed by the host page, changed DOM, other extensions, and unobserved event/API paths. The page itself sees typed text. There is no fetch/XHR patching, TLS interception, or DNR body rewriting. Chrome DNR is not a general request-body redaction facility. The local composer is the path that prevents the raw prompt from entering the AI website at all, assuming the user only copies the masked output.

## Plugin companion

The private portable plugin contains a setup skill and a copy of the verified extension build. It provides installation and coverage guidance; it does not expose a tool that asks the model to pass raw credentials to a scanner. Calling an MCP scanning tool after a model has read the prompt would be too late for this product's purpose. A plugin listing/install does not establish that the Chrome extension is installed or enabled.

## Other clients

Each additional host needs an independently verified pre-model integration. The core is portable; interception is host-specific.

| Client | Potential integration | Status |
| --- | --- | --- |
| ChatGPT / Claude Chrome websites | Local composer + browser event guards | Implemented pilot; fixtures tested |
| Codex / ChatGPT Work local runtime | Trusted local lifecycle hook if the current host supports prompt gating | Research only; not bundled or enabled |
| Claude Code | Local `UserPromptSubmit` command hook with supported blocking/rewrite semantics | Research only; not bundled or enabled |
| Custom AI application | Import scanner before request serialization | Scanner API included; app integration unimplemented |
| Enterprise agent fleet | Approved endpoint/SDK enforcement and central policy distribution | Future work |

Official reference material checked during implementation:

- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome managed storage](https://developer.chrome.com/docs/extensions/reference/api/storage#property-managed)
- [OpenAI plugin packaging and hook trust](https://developers.openai.com/plugins/build/plugins)
- [OpenAI lifecycle hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)

Do not infer native-client coverage from these references: native adapters have not been built or tested.
