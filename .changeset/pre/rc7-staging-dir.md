---
"@kamino/server": patch
---

An upload opened before the server's container was recreated no longer fails with 500: if its staging folder is gone, the server recreates it and the device simply sends the chunks again.
