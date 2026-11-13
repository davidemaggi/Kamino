# @kamino/server

## 1.0.0-rc.2

### Patch Changes

- Right after the first setup, the new admin is taken to the two-step verification page instead of seeing a `totp_mandatory` error.

## 1.0.0-rc.1

### Major Changes

- First stable release, 1.0 "Ash": self-hosted sync for Obsidian vaults with a plugin for desktop and mobile, a containerized server and a web app. Encrypted paths and names at rest, conflicts that never lose a version, history and trash, pairing of new devices, user and admin areas, key rotation, verified backups.

### Minor Changes

- e91e481: Real web authentication: first-run setup link, sign-in with Argon2id passwords and TOTP with recovery codes, cookie sessions with expiry and revocation, account settings and security log, CLI to create invitation and reset links and to reset 2FA. The server verifies the master key before running database migrations. Encryption module for vault keys, fields and blobs. The web app gains a hybrid development mode against the real server.
- 06dbe49: Sync server: device linking with credentials and revocable device tokens, encrypted vaults, chunked uploads encrypted on arrival with ranged downloads, blob storage on the file system or any S3-compatible service, and commits decided by the shared sync arbiter with journal, snapshot, acknowledgements and device status. The web app's vault list and summary now come from the real server in hybrid mode.
- 1874315: Real-time sync on the server: devices receive changes over a WebSocket, with catch-up in pages, acknowledgements, status reports, heartbeat and immediate disconnection when revoked. Commits are fanned out through Postgres notifications, so several server instances can share one database. The journal is compacted nightly behind active devices and history retention, and devices that fall behind start again from a snapshot. Background jobs run on pg-boss. Devices can be listed, renamed and revoked from the web app and the plugin, and vault sync settings with per-device overrides are stored encrypted. By default no configuration folder category is synced.
- 135f80b: Conflicts and history are writable: resolve conflicts from the web app (keep mine, keep incoming, keep both as a side-by-side copy, manual merge, resolve all), restore an old version or a file from the trash. Devices resolve conflicts with a new `resolve` operation in the normal commit. A daily job applies the history retention, empties the trash after max(7 days, retention) and removes content nothing references any more.
- aa86b83: User area on the real server: vault detail, rename and delete, file history and trash, conflict list and detail, vault ZIP (also as of a past date). Restoring and resolving are shown as coming soon.
- b19ea60: Admin area on the real server: users (invite, block, reset link, delete with an optional ZIP export by email), roles and per-user quotas, system settings from the environment or the web app, SMTP email through a durable outbox, health and audit log. Storage quotas refuse new content only.
- e6cd390: Pairing with a QR code or a magic link: a device of the vault (or the web app) offers a one-time link valid ten minutes, the new device claims it, both show the same four-character code and the origin approves. The new device receives its token once; the server stores only hashes. The link can also be sent by email.
- 05697d2: Master key rotation without downtime (`keys rotate`, with the old key in `KAMINO_MASTER_KEY_PREVIOUS[_FILE]` during the switch) and full backups: `backup create` (database and encrypted blobs in one ZIP, never the key), `backup verify` (restores into a temporary database and decrypts a sample of blobs) and `backup restore` onto an empty installation.

### Patch Changes

- e460d4b: Accept UTF-16/UTF-8-BOM secret files (Windows PowerShell), strip the trailing slash from `KAMINO_PUBLIC_URL`, mention the Docker command in the master key format error, and print a clear message when `migrate` cannot reach the database.
- 424afb0: The plugin resolves conflicts for real: keep mine, keep incoming, keep both as a side-by-side copy, manual merge and resolve all, without ever losing the local copy. Conflicts resolved from the web app or another device are followed, and conflicts this device can't resolve are shown with a hint to resolve them elsewhere. The snapshot's open conflicts carry the file's current version.
- 068fca7: Security hardening: a strict Content-Security-Policy and the usual security headers on every answer (HSTS behind an HTTPS public URL), API answers never cached, rate limits on ZIP exports, web restores and resolutions and upload sessions.
- 7bc0120: Faster sync on large vaults (the client no longer copies its whole state the slow way on every event; tested with 10,000 files), a plugin bundle 60% smaller, deeper redaction of secrets in the logs, a database-side timeout on the readiness check, master keys accepted only in canonical base64, and a manual GitHub workflow that publishes the plugin for BRAT.
- Logs for troubleshooting: the server logs its version, commit and protocol at startup and every failing background job (name and error class only), the Docker compose files rotate container logs, and the plugin keeps a codes-only diagnostic log in its folder that the "Copy diagnostics" command and a button in the settings copy for a support request. Never paths, file names, contents or secrets.
