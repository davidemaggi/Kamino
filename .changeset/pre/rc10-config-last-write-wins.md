---
"@kamino/server": patch
"@kamino/plugin": patch
"@kamino/web": patch
---

Configuration folder files (`.obsidian`) no longer open conflicts: the last change to arrive wins, and the other stays in the history. Open conflicts on those files close at the next change. A new file with the same content as one already at its path joins it. The configuration folder sync is marked Beta.
