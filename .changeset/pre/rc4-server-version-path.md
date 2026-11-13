---
"@kamino/server": patch
---

- The plugin's "Check" no longer says the server is unreachable: `/version` is also served under `/api/v1`, where the plugin looks for it.
