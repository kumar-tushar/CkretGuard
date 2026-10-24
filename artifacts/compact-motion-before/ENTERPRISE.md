# Enterprise pilot and production work

This build includes managed settings, local processing, narrow host coverage, no raw-content audit, deterministic tests, bounded scanner work, and closed failure behavior on recognized submission paths. It is suitable for engineering evaluation. It has not received an independent audit or production certification.

## Managed policy

After obtaining a stable signed Chrome extension ID, administrators can distribute the extension using their normal Chrome Enterprise deployment tools. This repository does not include a signing key, Web Store listing, update server, enrollment system, or invented extension ID.

Map the following values into that extension's managed storage using Chrome's platform-specific policy deployment format. `policy.example.json` is the **inner extension policy object**, not a ready-to-import Chrome/MDM configuration.

```json
{
  "mode": "redact",
  "protectClientIds": true,
  "sensitiveNames": ["internal_access_code", "partner_credential"]
}
```

`mode` is `redact` or `block`. Both modes cancel the initial send when credentials are detected and open a **Secrets detected** review dialog with the exact detected occurrence count. This count is not a count of confirmed leaks or a guarantee of exhaustive detection. The default `redact` mode offers **Send** (send the unchanged draft for one attempt), **Edit** (preserve and focus the draft, send nothing), and **Mask** (replace detected values with `xxxxx` and automatically send the masked prompt once). `block` disables **Send** while retaining **Edit** and **Mask**. Automatic masked sending requires a successful re-scan and revalidation of the current draft and policy. The local composer still requires manual masking, review, and copying and never sends prompts. Pasting does not modify text; scanning occurs at submission. All managed fields override local preferences and are disabled in the settings UI. Do not put real secrets in policy: additional names are field labels only. Invalid policy makes the guard unavailable and blocks recognized send controls; the review dialog does not override policy or scan failures.

The schema is `extension/managed-schema.json`. Managed-storage precedence and failure behavior are tested with a local mock; real MDM installation, policy delivery, and force-install restrictions require validation in your organization.

## Before broad rollout

1. Test the unpacked pilot on disposable Chrome profiles against the actual current ChatGPT and Claude editors. Use synthetic tokens. Check textarea/contenteditable, send click, Enter, keyboard activation, paste, multilingual UI, edits, navigation, model changes, and rich text. Verify **Send** submits the original only after explicit selection, **Edit** leaves the original draft without sending, and **Mask** automatically submits the masked prompt exactly once after validation. Check the detected occurrence count and verify changed drafts or policies cannot reuse a prior approval. Confirm provider request bodies match the user's selected choice and managed Block mode prevents original sending. Test supported Chrome versions and operating systems.
2. Run an independent security review with adversarial input, regex/work-bound evaluation, false-positive/false-negative measurement, and privacy review. The browser guard must be described as cooperative UI protection rather than a network enforcement guarantee.
3. Sign and publish through an approved Chrome distribution channel. Establish a stable extension ID, reviewed updates, rollback procedure, artifact verification, and a provider-DOM compatibility response process.
4. Verify force installation, site-access policy, managed settings, disabled-extension reporting, and extension-conflict behavior in the target MDM. Enforcement needs device/browser management; a user-controlled extension alone is bypassable.
5. Define data classes and expected detection coverage with each customer. Add reviewed detectors and synthetic regression tests. Unlabeled custom IDs, arbitrary secrets, encoded input, attachments, images, and tool output require additional capabilities.
6. If an organization needs complete pre-model enforcement across agents, build host-specific hooks/SDK integrations or an approved outbound gateway at the request boundary. Scope both prompts and tool/file context, avoid logging original bodies, and verify each client independently.

No centralized audit or identity service is included. Add one only with explicit requirements for authenticated enrollment, authorization, content-free events, retention, residency, access review, and incident response. Do not add raw prompt logging to measure adoption.
