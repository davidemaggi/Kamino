# @kamino/plugin

## 1.0.0-rc.2

No changes in this release.

## 1.0.0-rc.1

### Major Changes

- First stable release, 1.0 "Ash": self-hosted sync for Obsidian vaults with a plugin for desktop and mobile, a containerized server and a web app. Encrypted paths and names at rest, conflicts that never lose a version, history and trash, pairing of new devices, user and admin areas, key rotation, verified backups.

### Minor Changes

- 2e081ea: The plugin now really syncs the vault with the server: it scans the vault (rehashing only changed files), watches it for changes, uploads in resumable chunks and downloads in pieces without holding large files in memory, and keeps its state written ahead of every action so a crash never loses work. Devices link to the server with username, password and verification code; the initial transfer shows files and bytes and can be paused. Folders, including empty ones, are synced too. The status indicator and panel show the real state, the pending changes and any deferred file. Sync settings follow the vault defaults or this device's choices. A device that comes back after a long absence catches up from a snapshot without losing local changes. QR pairing and conflict resolution are shown as coming soon. Development builds keep the simulated server; production builds never contain it.
- 4cfe226: Changes now reach your other devices within seconds: in Live mode the plugin keeps a connection to the server and fetches changes as soon as they happen, reconnecting by itself. Periodic and Manual modes are available per device and apply at once. Large attachments can wait for Wi-Fi (on iPhone the plugin asks), a note open with unsaved edits is never overwritten, and warnings repeat every hour while something is wrong. Files that can't be sent yet are listed with the reason. Several smaller robustness fixes: safer file replacement with crash recovery, case-only renames on Windows and macOS, a per-file fallback when streaming fails, HTTPS enforced on phones for every request, clearer login errors.
- 424afb0: The plugin resolves conflicts for real: keep mine, keep incoming, keep both as a side-by-side copy, manual merge and resolve all, without ever losing the local copy. Conflicts resolved from the web app or another device are followed, and conflicts this device can't resolve are shown with a hint to resolve them elsewhere. The snapshot's open conflicts carry the file's current version.
- e6cd390: Pairing with a QR code or a magic link: a device of the vault (or the web app) offers a one-time link valid ten minutes, the new device claims it, both show the same four-character code and the origin approves. The new device receives its token once; the server stores only hashes. The link can also be sent by email.
- d752c72: Add the welcome view, manual linking with initial transfer, pairing by QR code or link with approval, and the full settings tab.
- 90f4e57: Add the sync status panel and conflict resolution views (side-by-side diff on desktop, tabs with a unified diff on mobile, binary files, resolve all), built on a CodeMirror merge view.
- 9f92778: Add the design system foundations: shared sync status vocabulary, web design tokens with bundled fonts and flash-free theme, and a never-silent status indicator in the plugin.

### Patch Changes

- A file whose upload the server refused (too many uploads at once, or a server error) is no longer shown as safe until the next cycle: it stays counted among the pending changes, and the plugin tries again by itself with backoff instead of waiting for the next local change.
- 7bc0120: Faster sync on large vaults (the client no longer copies its whole state the slow way on every event; tested with 10,000 files), a plugin bundle 60% smaller, deeper redaction of secrets in the logs, a database-side timeout on the readiness check, master keys accepted only in canonical base64, and a manual GitHub workflow that publishes the plugin for BRAT.
- Logs for troubleshooting: the server logs its version, commit and protocol at startup and every failing background job (name and error class only), the Docker compose files rotate container logs, and the plugin keeps a codes-only diagnostic log in its folder that the "Copy diagnostics" command and a button in the settings copy for a support request. Never paths, file names, contents or secrets.
