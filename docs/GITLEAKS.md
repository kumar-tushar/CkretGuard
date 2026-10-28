# Gitleaks rule integration

The first replacement detector implements **only `generic-api-key`**, pinned to
[Gitleaks commit `5f6ec56`](https://github.com/gitleaks/gitleaks/blob/5f6ec56cfa6f8c67648d863582c7ae2f206d5c1c/config/gitleaks.toml).
The upstream MIT license is included in `extension/licenses/GITLEAKS.txt` and
copied into the unpacked build and packages.

`src/gitleaks-rules.js` contains the pinned rule, its four allowlists, its complete
1,446-entry stopword list, and the global content exclusions. It also preserves
the original Go rule expression for comparison. `src/core.js` compiles and
validates the bundled rules, applies the keyword prefilter, extracts the selected
capture group, requires entropy **greater than 3.5**, evaluates secret/match/line
exclusions, and returns ordered, distinct occurrence spans. Findings contain
offsets and the rule ID, not additional copies of the secret text.

The regex port expands Go case-folding into explicit character classes, converts
Go's ASCII whitespace and strict end-of-input anchors, and avoids modifier-group
syntax so the existing Chrome 120 minimum remains supported. Offsets use UTF-16
indices as required by the existing JavaScript editor and masking APIs.

```text
api_key = N7q2V9m4R8s6T3x5K1p0L2z7H4c9D6b8
```

This example opens the existing review and masks to `api_key = xxxxxxxxxx`.
`key={event.id}` and ordinary API-key discussion do not match. The rule's label,
separator, character, length, entropy and exclusion requirements must all pass.
Some alphanumeric/base64 values can exceed 150 characters; the 150-character
limit applies to the other candidate branch, not to every value.

## Scope of this step

- Send, Edit, Mask, strict mode, History, counters, custom-field controls and all
  nine browser adapters retain their existing behavior and design.
- Saved custom names and the client-ID preference remain stored, but no separate
  custom-name or client-ID matching rule is enabled in this first step.
- Standalone provider rules, grouped/distant-value heuristics and other retired
  CkretGuard detectors are not restored. Provider rules will be added separately.
- This does not implement filename/commit scanning, decoding, baselines, ignore
  fingerprints, or credential validity checks. A prompt has no file path, so an
  upstream exclusion requiring both a path and a line cannot match it.
- Inline `gitleaks:allow` comments do not bypass protection. This corresponds to
  running Gitleaks with `--ignore-gitleaks-allow`.

## Verification

`tests/fixtures/gitleaks-generic.json` records 371 independently evaluated cases
from the official Gitleaks **8.30.1** binary, using the pinned config,
`--enable-rule generic-api-key`, `--max-decode-depth 0` and
`--ignore-gitleaks-allow`. The downloaded binary's SHA-256 was checked against the
official release checksum file. It is used only to generate reference results,
not shipped or required at runtime or in CI.

`tests/gitleaks.test.mjs` compares extracted values to that reference, verifies
exact offsets and masking, entropy/length boundaries, malformed-rule failures,
and complete large drafts. The active-rule browser cases in
`tests/browser/detection-removal.spec.mjs` exercise repeated Enter/click attempts
with Send, Edit and Mask across all nine routed provider fixtures. No real
credentials or requests to live AI services are used.

The older detector suites still describe the removed CkretGuard implementation;
their legacy expectations are not evidence of Gitleaks compatibility.
