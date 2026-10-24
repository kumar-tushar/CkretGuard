# CkretGuard — rushed-input test results

Test date: 25 October 2026. Version: 1.0.0. Verified saved commit: `25c78e2` on `codex/secret-shield`.

All inputs are synthetic. Browser checks use isolated Chromium with locally intercepted ChatGPT and Claude editor fixtures. No test prompts were sent to the live AI services; this does not verify their current production page layouts.

## Final results

- **38 unit tests passed.**
- **72 browser tests passed** in the final complete run.
- **1,200 deterministic formatting combinations passed**, each checked against its expected full masked output and scanned again for zero remaining findings.
- Both release ZIPs were rebuilt and their integrity checked. They contain the verified scanner.

## Browser behavior verified

- Mixed capitalization, joined/spaced/hyphen/underscore labels, uneven spaces and tabs, nonbreaking spaces, fullwidth separators, next-line values, straight/curly quotes, unfinished quotes, and empty assignments before another credential.
- Edit preserves the original draft and sends nothing.
- Send submits the reviewed original once after explicit selection.
- Mask submits the expected fully masked text once. Captured outgoing request bodies are compared with the expected text.
- Held Enter, rapid Send clicks, repeated review-button clicks, and repeated form submissions do not duplicate sending in the tested flows.
- Changes to the draft, editor, or policy cancel stale approvals. Failed scans, invalid policy, missing inputs, and rejected editor updates block the recognized sending paths.
- Long prompts above 100,000 characters, custom fields and their 50-field limit, client-ID settings, managed settings, activity counters, popup actions, and five-second notices.

## Issues fixed during testing

- Assigned values on the next line were missed.
- Curly-quoted values with spaces could be only partly masked.
- A missing closing quote could leave an assigned credential visible.
- Nonbreaking spaces and fullwidth assignment characters could prevent detection.
- Bearer/Basic scheme words could be counted as extra credentials.
- Quoted Bearer/Basic tokens could remain visible after masking.
- Complete unquoted `${VARIABLE}` placeholders could be partly masked; they now remain unchanged.
- An empty assignment could consume the next field name and leave its actual value visible.

## Remaining detection limits

These cases remain unsupported and are **not** counted as successful detection checks:

### Missing separator

Input:

```text
client secret fake-unseparated-123
```

Findings: 0. Result:

```text
client secret fake-unseparated-123
```

### Grouped field names and unlabeled values

Input:

```text
client id and client secret are
fake-client-123
fake-secret-456
```

Findings: 0. Result:

```text
client id and client secret are
fake-client-123
fake-secret-456
```

### Misspelled field name

Input:

```text
clinet secrect: fake-typo-123
```

Findings: 0. Result:

```text
clinet secrect: fake-typo-123
```

### Unquoted value containing spaces

Input:

```text
password=fake password phrase 123
```

Findings: 1. Result:

```text
password=xxxxx password phrase 123
```

Missing separators, misspelled names, and grouped unlabeled values can pass without a warning. Unquoted multiword values can be only partly masked. Use an explicit assignment for each credential and quote values containing spaces, for example:

```text
client id: fake-client-123
client secret: "fake secret phrase 456"
```

## Run interruptions

- One intermediate run timed out during dashboard startup. An isolated startup probe passed with the expected policy and no page errors; the cause of the timeout was not established.
- Another intermediate run passed 68 browser tests before source/config files became unavailable when the shared repository switched to main. The complete final run used an isolated archive of the saved commit and passed all 72 browser tests.

The final result applies to the saved version above. The shared checkout was left on its externally selected branch; its source files were not restored or overwritten.

Scanner SHA-256: `fb8c9b014a9f9655d61896f0b2bbe5ab6f193bd596a7f13de96c1379d7eb9ff6`.

The adjacent JSON report contains all 1,200 synthetic inputs and expected outputs, the remaining gap examples, the verified commit, and release hashes.
