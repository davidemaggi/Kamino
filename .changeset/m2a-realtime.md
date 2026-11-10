---
"@kamino/server": minor
"@kamino/web": patch
---

Real-time sync on the server: devices receive changes over a WebSocket, with catch-up in pages, acknowledgements, status reports, heartbeat and immediate disconnection when revoked. Commits are fanned out through Postgres notifications, so several server instances can share one database. The journal is compacted nightly behind active devices and history retention, and devices that fall behind start again from a snapshot. Background jobs run on pg-boss. Devices can be listed, renamed and revoked from the web app and the plugin, and vault sync settings with per-device overrides are stored encrypted. By default no configuration folder category is synced.
