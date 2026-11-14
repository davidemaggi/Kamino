# @kamino/web

## 1.0.0-rc.8

### Patch Changes

- d34b0c0: The web app can change what a vault syncs by default (configuration folder categories and exclusions), so "Use the vault settings" in the plugin follows choices the owner can actually make.

## 1.0.0-rc.7

No changes in this release.

## 1.0.0-rc.6

No changes in this release.

## 1.0.0-rc.5

No changes in this release.

## 1.0.0-rc.4

### Patch Changes

- New "Obsidian" identity: new icon, obsidian-dark backgrounds with a violet accent, dark theme by default (new users and first visit), "Decision" status in magenta, and the brand glyph on the plugin's status panel and welcome tab.

## 1.0.0-rc.3

No changes in this release.

## 1.0.0-rc.2

No changes in this release.

## 1.0.0-rc.1

### Major Changes

- First stable release, 1.0 "Ash": self-hosted sync for Obsidian vaults with a plugin for desktop and mobile, a containerized server and a web app. Encrypted paths and names at rest, conflicts that never lose a version, history and trash, pairing of new devices, user and admin areas, key rotation, verified backups.

### Minor Changes

- e91e481: Real web authentication: first-run setup link, sign-in with Argon2id passwords and TOTP with recovery codes, cookie sessions with expiry and revocation, account settings and security log, CLI to create invitation and reset links and to reset 2FA. The server verifies the master key before running database migrations. Encryption module for vault keys, fields and blobs. The web app gains a hybrid development mode against the real server.
- 135f80b: Conflicts and history are writable: resolve conflicts from the web app (keep mine, keep incoming, keep both as a side-by-side copy, manual merge, resolve all), restore an old version or a file from the trash. Devices resolve conflicts with a new `resolve` operation in the normal commit. A daily job applies the history retention, empties the trash after max(7 days, retention) and removes content nothing references any more.
- aa86b83: User area on the real server: vault detail, rename and delete, file history and trash, conflict list and detail, vault ZIP (also as of a past date). Restoring and resolving are shown as coming soon.
- 9f92778: Add the design system foundations: shared sync status vocabulary, web design tokens with bundled fonts and flash-free theme, and a never-silent status indicator in the plugin.
- 938d981: Add the admin area: users, quotas, activation and reset links, system configuration with environment-locked fields, test email, health and audit log.
- 11feed2: Add the web app shell with navigation, sign-in with two-step verification, setup, password reset, invites and the account page, on a typed API contract (fake API in development).
- 630e5d8: Add the user area: overview, vaults with history, trash and settings, devices, pairing from the web and the conflict center.

### Patch Changes

- 06dbe49: Sync server: device linking with credentials and revocable device tokens, encrypted vaults, chunked uploads encrypted on arrival with ranged downloads, blob storage on the file system or any S3-compatible service, and commits decided by the shared sync arbiter with journal, snapshot, acknowledgements and device status. The web app's vault list and summary now come from the real server in hybrid mode.
- 1874315: Real-time sync on the server: devices receive changes over a WebSocket, with catch-up in pages, acknowledgements, status reports, heartbeat and immediate disconnection when revoked. Commits are fanned out through Postgres notifications, so several server instances can share one database. The journal is compacted nightly behind active devices and history retention, and devices that fall behind start again from a snapshot. Background jobs run on pg-boss. Devices can be listed, renamed and revoked from the web app and the plugin, and vault sync settings with per-device overrides are stored encrypted. By default no configuration folder category is synced.
- b19ea60: Admin area on the real server: users (invite, block, reset link, delete with an optional ZIP export by email), roles and per-user quotas, system settings from the environment or the web app, SMTP email through a durable outbox, health and audit log. Storage quotas refuse new content only.
- e6cd390: Pairing with a QR code or a magic link: a device of the vault (or the web app) offers a one-time link valid ten minutes, the new device claims it, both show the same four-character code and the origin approves. The new device receives its token once; the server stores only hashes. The link can also be sent by email.
- 068fca7: Security hardening: a strict Content-Security-Policy and the usual security headers on every answer (HSTS behind an HTTPS public URL), API answers never cached, rate limits on ZIP exports, web restores and resolutions and upload sessions.
