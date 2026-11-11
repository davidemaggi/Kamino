---
"@kamino/plugin": minor
---

The plugin now really syncs the vault with the server: it scans the vault (rehashing only changed files), watches it for changes, uploads in resumable chunks and downloads in pieces without holding large files in memory, and keeps its state written ahead of every action so a crash never loses work. Devices link to the server with username, password and verification code; the initial transfer shows files and bytes and can be paused. Folders, including empty ones, are synced too. The status indicator and panel show the real state, the pending changes and any deferred file. Sync settings follow the vault defaults or this device's choices. A device that comes back after a long absence catches up from a snapshot without losing local changes. QR pairing and conflict resolution are shown as coming soon. Development builds keep the simulated server; production builds never contain it.
