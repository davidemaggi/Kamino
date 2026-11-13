---
"@kamino/server": minor
"@kamino/web": minor
---

Conflicts and history are writable: resolve conflicts from the web app (keep mine, keep incoming, keep both as a side-by-side copy, manual merge, resolve all), restore an old version or a file from the trash. Devices resolve conflicts with a new `resolve` operation in the normal commit. A daily job applies the history retention, empties the trash after max(7 days, retention) and removes content nothing references any more.
