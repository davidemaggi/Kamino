---
"@kamino/server": patch
"@kamino/plugin": patch
---

Faster sync on large vaults (the client no longer copies its whole state the slow way on every event; tested with 10,000 files), a plugin bundle 60% smaller, deeper redaction of secrets in the logs, a database-side timeout on the readiness check, master keys accepted only in canonical base64, and a manual GitHub workflow that publishes the plugin for BRAT.
