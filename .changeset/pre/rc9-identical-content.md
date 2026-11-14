---
"@kamino/server": patch
"@kamino/plugin": patch
---

Two devices writing the same content no longer open a conflict: the server accepts the put as its current version. Fixes configuration files (`app.json` and others) that kept coming back as conflicts right after being resolved.
