# CkretGuard website

Static homepage, Privacy Policy, and existing Terms and Conditions for the CkretGuard production extension. The website reuses the extension's DM Sans font, logo, provider icons, graphite background, and Lagoon Teal brand color. These files are separate from the extension ZIP. No Firebase SDK, analytics, database, payment service, or server is required.

## Published pages

- Home: https://ckretguard.web.app
- Privacy Policy: https://ckretguard.web.app/privacy-policy
- Terms and Conditions: https://ckretguard.web.app/terms-and-conditions
- The previous `/privacy` address redirects permanently to `/privacy-policy` so existing links keep working.
- The previous `/terms` address redirects permanently to `/terms-and-conditions`.
- Firebase project and Hosting site: `ckretguard`

## Update and deploy

Use Node 24 LTS and the official Firebase CLI. Authenticate with `firebase login` if necessary. From this `hosting/` directory:

```sh
firebase hosting:sites:list --project ckretguard
firebase deploy --only hosting --project ckretguard
```

Verify that the listed site is `projects/ckretguard/sites/ckretguard` before deploying. `firebase.json` explicitly selects that site and uploads only `public/`. Do not deploy to the separate AgentGuard project. Test the public URLs on desktop and mobile after any change. Keep the Chrome Web Store privacy-policy URL in sync. Fonts and icons are served locally; preserve their bundled license files when updating them. The homepage uses a static, clearly labeled example with dummy data and does not collect or submit prompts.

Publishing these website pages does not publish or submit the Chrome extension. The documents describe CkretGuard 1.0.0: local scanning, 90-day unmasked-send History without extension encryption, local settings and counters, no production debug logger, nine supported chat providers, and support at connect.orenthic@gmail.com. Update their text and revision dates when those practices or terms change. No Firebase credentials belong in this directory or in Git.
