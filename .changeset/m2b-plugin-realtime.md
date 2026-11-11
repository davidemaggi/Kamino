---
"@kamino/plugin": minor
"@kamino/status": minor
---

Changes now reach your other devices within seconds: in Live mode the plugin keeps a connection to the server and fetches changes as soon as they happen, reconnecting by itself. Periodic and Manual modes are available per device and apply at once. Large attachments can wait for Wi-Fi (on iPhone the plugin asks), a note open with unsaved edits is never overwritten, and warnings repeat every hour while something is wrong. Files that can't be sent yet are listed with the reason. Several smaller robustness fixes: safer file replacement with crash recovery, case-only renames on Windows and macOS, a per-file fallback when streaming fails, HTTPS enforced on phones for every request, clearer login errors.
