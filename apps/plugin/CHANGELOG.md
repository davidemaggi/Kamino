# @kamino/plugin

## 1.0.1

### Patch Changes

- Plugin releases carry GitHub artifact attestations, and the repository root holds `manifest.json` and `versions.json`, as the Obsidian community store requires.

## 1.0.0

### Major Changes

- 9f97ea2: First stable release, 1.0 "Ash": self-hosted sync for Obsidian vaults with a plugin for desktop and mobile, a containerized server and a web app. Encrypted paths and names at rest, conflicts that never lose a version, history and trash, pairing of new devices, user and admin areas, key rotation, verified backups.

### Minor Changes

- 2e081ea: The plugin now really syncs the vault with the server: it scans the vault (rehashing only changed files), watches it for changes, uploads in resumable chunks and downloads in pieces without holding large files in memory, and keeps its state written ahead of every action so a crash never loses work. Devices link to the server with username, password and verification code; the initial transfer shows files and bytes and can be paused. Folders, including empty ones, are synced too. The status indicator and panel show the real state, the pending changes and any deferred file. Sync settings follow the vault defaults or this device's choices. A device that comes back after a long absence catches up from a snapshot without losing local changes. QR pairing and conflict resolution are shown as coming soon. Development builds keep the simulated server; production builds never contain it.
- 4cfe226: Changes now reach your other devices within seconds: in Live mode the plugin keeps a connection to the server and fetches changes as soon as they happen, reconnecting by itself. Periodic and Manual modes are available per device and apply at once. Large attachments can wait for Wi-Fi (on iPhone the plugin asks), a note open with unsaved edits is never overwritten, and warnings repeat every hour while something is wrong. Files that can't be sent yet are listed with the reason. Several smaller robustness fixes: safer file replacement with crash recovery, case-only renames on Windows and macOS, a per-file fallback when streaming fails, HTTPS enforced on phones for every request, clearer login errors.
- 424afb0: The plugin resolves conflicts for real: keep mine, keep incoming, keep both as a side-by-side copy, manual merge and resolve all, without ever losing the local copy. Conflicts resolved from the web app or another device are followed, and conflicts this device can't resolve are shown with a hint to resolve them elsewhere. The snapshot's open conflicts carry the file's current version.
- e6cd390: Pairing with a QR code or a magic link: a device of the vault (or the web app) offers a one-time link valid ten minutes, the new device claims it, both show the same four-character code and the origin approves. The new device receives its token once; the server stores only hashes. The link can also be sent by email.
- d752c72: Add the welcome view, manual linking with initial transfer, pairing by QR code or link with approval, and the full settings tab.
- 90f4e57: Add the sync status panel and conflict resolution views (side-by-side diff on desktop, tabs with a unified diff on mobile, binary files, resolve all), built on a CodeMirror merge view.
- 9f92778: Add the design system foundations: shared sync status vocabulary, web design tokens with bundled fonts and flash-free theme, and a never-silent status indicator in the plugin.

### Patch Changes

- d8d0ace: Obsidian configuration JSON files (plugin lists, settings, plugin data) rewritten by Obsidian from a stale memory are merged with the version that arrived from another device, instead of replacing it (ADR-0020).
- 7bc0120: Faster sync on large vaults (the client no longer copies its whole state the slow way on every event; tested with 10,000 files), a plugin bundle 60% smaller, deeper redaction of secrets in the logs, a database-side timeout on the readiness check, master keys accepted only in canonical base64, and a manual GitHub workflow that publishes the plugin for BRAT.
- b370030: Once per session the plugin checks that the server still has the content of the files it confirmed, and uploads again whatever the server lost, so the other devices can download it.
- 9f97ea2: Logs for troubleshooting: the server logs its version, commit and protocol at startup and every failing background job (name and error class only), the Docker compose files rotate container logs, and the plugin keeps a codes-only diagnostic log in its folder that the "Copy diagnostics" command and a button in the settings copy for a support request. Never paths, file names, contents or secrets.
- 652a7f8: Configuration folder files (`.obsidian`) no longer open conflicts: the last change to arrive wins, and the other stays in the history. Open conflicts on those files close at the next change. A new file with the same content as one already at its path joins it. The configuration folder sync is marked Beta.
- 94b30c4: "Link…" in the settings and in the status panel opens the three choices in a window on top, instead of a tab hidden behind the settings (or behind the drawer on mobile). A failed create or link in the connect window now shows an error instead of doing nothing.
- 015a974: New "Obsidian" identity: new icon, obsidian-dark backgrounds with a violet accent, dark theme by default (new users and first visit), "Decision" status in magenta, and the brand glyph on the plugin's status panel and welcome tab.
- 1676115: A file replaced by the plugin (for example "keep incoming" on a conflict) could vanish from the device: the moment the old copy was set aside in the plugin's folder was taken for the user moving it there. The plugin now ignores its own folder in renames, and a device already affected downloads the file again (never deletes it).
- c564c90: In the mobile menu the sync status entry shows the logo and a title, instead of a clock with no text.
- 75ee631: When another device changes Obsidian's configuration folder (plugins, appearance, settings), the plugin shows a notice with a "Reload now" button, since Obsidian reads that folder only at startup.
- d1a7e40: Two devices writing the same content no longer open a conflict: the server accepts the put as its current version. Fixes configuration files (`app.json` and others) that kept coming back as conflicts right after being resolved.
- 6c12399: A file whose upload the server refused (too many uploads at once, or a server error) is no longer shown as safe until the next cycle: it stays counted among the pending changes, and the plugin tries again by itself with backoff instead of waiting for the next local change.

## 1.0.0-rc.11

### Patch Changes

- d8d0ace: Obsidian configuration JSON files (plugin lists, settings, plugin data) rewritten by Obsidian from a stale memory are merged with the version that arrived from another device, instead of replacing it (ADR-0020).
- b370030: Once per session the plugin checks that the server still has the content of the files it confirmed, and uploads again whatever the server lost, so the other devices can download it.

## 1.0.0-rc.10

### Patch Changes

- Forced sync: choose a source device and the devices to align, from the web app (vault › Devices) or from the plugin ("Force sync from this device"). The source's files overwrite the same files on the chosen devices; their different copies stay in the history, and files only they have are kept. Each device realigns at its next connection.

- Configuration folder files (`.obsidian`) no longer open conflicts: the last change to arrive wins, and the other stays in the history. Open conflicts on those files close at the next change. A new file with the same content as one already at its path joins it. The configuration folder sync is marked Beta.

## 1.0.0-rc.9

### Patch Changes

- Two devices writing the same content no longer open a conflict: the server accepts the put as its current version. Fixes configuration files (`app.json` and others) that kept coming back as conflicts right after being resolved.

## 1.0.0-rc.8

### Patch Changes

- 75ee631: When another device changes Obsidian's configuration folder (plugins, appearance, settings), the plugin shows a notice with a "Reload now" button, since Obsidian reads that folder only at startup.

## 1.0.0-rc.7

No changes in this release.

## 1.0.0-rc.6

### Patch Changes

- c564c90: In the mobile menu the sync status entry shows the logo and a title, instead of a clock with no text.

## 1.0.0-rc.5

### Patch Changes

- A file replaced by the plugin (for example "keep incoming" on a conflict) could vanish from the device: the moment the old copy was set aside in the plugin's folder was taken for the user moving it there. The plugin now ignores its own folder in renames, and a device already affected downloads the file again (never deletes it).

## 1.0.0-rc.4

### Patch Changes

- New "Obsidian" identity: new icon, obsidian-dark backgrounds with a violet accent, dark theme by default (new users and first visit), "Decision" status in magenta, and the brand glyph on the plugin's status panel and welcome tab.

- The plugin's "Check" no longer says the server is unreachable: `/version` is also served under `/api/v1`, where the plugin looks for it.

## 1.0.0-rc.3

### Patch Changes

- "Link…" in the settings and in the status panel opens the three choices in a window on top, instead of a tab hidden behind the settings (or behind the drawer on mobile). A failed create or link in the connect window now shows an error instead of doing nothing.

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
