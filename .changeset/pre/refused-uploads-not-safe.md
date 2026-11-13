---
"@kamino/plugin": patch
---

A file whose upload the server refused (too many uploads at once, or a server error) is no longer shown as safe until the next cycle: it stays counted among the pending changes, and the plugin tries again by itself with backoff instead of waiting for the next local change.
