# Enterprise pilot and production work

This build includes managed settings, local processing, narrow host coverage, local unmasked-send History, deterministic tests, bounded scanner work, and closed failure behavior on recognized submission paths. It is suitable for engineering evaluation. It has not received an independent audit or production certification.

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

`mode` is `redact` or `block`. Both modes cancel the initial send when credentials are detected and open a review dialog with the exact detected occurrence count in a single headline, such as **2 secrets detected**. This count is not a count of confirmed leaks or a guarantee of exhaustive detection. The default `redact` mode offers **Send** (send the unchanged draft for one attempt), **Edit** (preserve and focus the draft, send nothing), and **Mask** (replace detected values with `xxxxxxxxxx` and automatically send the masked prompt once). `block` removes **Send** from the popup while retaining **Edit** and **Mask**. The dashboard labels these modes **Send, Edit, or Mask** and **Edit or Mask**, respectively. Automatic masked sending requires a successful re-scan and revalidation of the current draft and policy. Custom secret fields can be added one at a time in the toolbar dashboard using Save. Up to 50 names are supported. Expand Custom secret fields to edit names. The count is plain text and saved names appear automatically below it, one per row, with remove buttons on the right. At the limit the input is hidden until a name is removed. Pasting does not modify text; scanning occurs at submission. All managed fields override local preferences and are disabled in the settings UI. Do not put real secrets in policy: additional names are field labels only. Invalid policy makes the guard unavailable and blocks recognized send controls; the review dialog does not override policy or scan failures.

The schema is `extension/managed-schema.json`. Managed-storage precedence and failure behavior are tested with a local mock; real MDM installation, policy delivery, and force-install restrictions require validation in your organization.

## Local activity counts

The dashboard stores three aggregate numeric totals on the device: detected secret occurrences, prompts forwarded after Mask, and prompts forwarded unchanged after Send. Each sending action increments one prompt even when it contains multiple secrets. Saving custom fields, failed editor updates, and an unavailable Send control do not increment a sent-prompt total. Repeated attempts count again. Existing detection totals are retained; the new prompt totals start at zero because legacy secret totals cannot be converted reliably. Send totals indicate the website send control was activated; they are not delivery acknowledgments. Counters contain no prompt content and are informational, not an enterprise audit trail.

## Local unmasked-send History

The full-tab sidebar includes History. Only prompts forwarded unchanged through the review's Send choice are recorded, with the complete prompt (including its secrets), detected count, time, site, and sanitized supported conversation link. Masked prompts, ordinary messages, Edit, and unsuccessful send activation do not create records. History begins with this update; there is no import of existing chats. Records indicate send attempts rather than provider delivery confirmation.

Records use extension-origin IndexedDB, separate from preferences and counters. Only the extension dashboard can list or delete them. They are local, unencrypted by CkretGuard, and not synced or uploaded. Users can delete entries individually or clear all History; this does not reset counts or delete provider messages. History retains the last 90 days. Older records are physically deleted before History operations, on worker startup, and by hourly local cleanup while Chrome is running. Browser storage limits and earlier user deletion also apply. Listings transfer paged metadata only; prompt text is loaded in bounded chunks on expansion. A failed write shows a notice and does not truncate the prompt. Evaluate this deliberate retention of raw credentials against your organization's requirements before deployment. This user-controlled history is not an immutable or authenticated audit service.

## Detection accuracy boundaries

The scanner preserves ordinary authentication prose such as `Explain the basic authentication flow.` and generic instructions such as `The key is to retry with exponential backoff.` Explicit authorization headers and quoted assignments remain protected; bare schemes require token evidence or a locally decodable Basic credential. These are deterministic context rules, not natural-language inference.

A separate whole-draft heuristic runs only when an enabled built-in or configured custom field is mentioned. It combines length, character variety, entropy, and readability checks to find opaque values anywhere in that draft. It runs alongside provider formats and explicit assignments, rather than as a fallback. Ordered label-to-next-line mapping has been removed. Explicitly identified opted-out client IDs and clearly labeled public metadata are excluded from the heuristic; unlabeled values cannot reliably be assigned to a field by position. Short, readable, obfuscated, and keyword-free indirect credentials may be missed. Readable passwords still match explicit assignments.

The review lists actual matched values without numbered detection labels. All checks are local; no validity test contacts a credential provider. Users can inspect matches before Send, Edit, or Mask. Production builds do not record debug events or diagnostic prompt snapshots. The separate unmasked-send History described above is retained.

Passing the browser and scanner regression suites verifies their tested contracts. It does not establish a measured enterprise false-positive/false-negative rate, current live-provider compatibility, or complete secret coverage. Calibrate these rules against representative synthetic customer prompts and explicit protection requirements before deployment.

## Before broad rollout

1. Test the unpacked pilot on disposable Chrome profiles against the actual current ChatGPT, Claude, Gemini, DeepSeek, Grok, Meta AI, Microsoft Copilot, Perplexity and Mistral editors. Use synthetic tokens. Check textarea/contenteditable, send click, Enter, keyboard activation, paste, multilingual UI, edits, navigation, model changes, and rich text. Verify **Send** submits the original only after explicit selection, **Edit** leaves the original draft without sending, and **Mask** automatically submits the masked prompt exactly once after validation. Check the detected occurrence count and verify changed drafts or policies cannot reuse a prior approval. Confirm provider request bodies match the user's selected choice and managed Block mode prevents original sending. Test supported Chrome versions and operating systems.
2. Run an independent security review with adversarial input, regex/work-bound evaluation, false-positive/false-negative measurement, and privacy review. The browser guard must be described as cooperative UI protection rather than a network enforcement guarantee.
3. Sign and publish through an approved Chrome distribution channel. Establish a stable extension ID, reviewed updates, rollback procedure, artifact verification, and a provider-DOM compatibility response process.
4. Verify force installation, site-access policy, managed settings, disabled-extension reporting, and extension-conflict behavior in the target MDM. Enforcement needs device/browser management; a user-controlled extension alone is bypassable.
5. Define data classes and expected detection coverage with each customer. Add reviewed detectors and synthetic regression tests. Unlabeled custom IDs, arbitrary secrets, encoded input, attachments, images, and tool output require additional capabilities.
6. If an organization needs complete pre-model enforcement across agents, build host-specific hooks/SDK integrations or an approved outbound gateway at the request boundary. Scope both prompts and tool/file context, avoid logging original bodies, and verify each client independently.

No centralized audit or identity service is included. Add one only with explicit requirements for authenticated enrollment, authorization, content-free events, retention, residency, access review, and incident response. Do not add raw prompt logging to measure adoption.
