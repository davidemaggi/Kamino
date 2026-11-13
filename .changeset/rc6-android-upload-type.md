---
"@kamino/server": patch
---

Uploads from Android no longer fail with 415: a chunk is taken as raw bytes whatever content type the device declares, and a bodyless request is accepted whatever type it declares.
