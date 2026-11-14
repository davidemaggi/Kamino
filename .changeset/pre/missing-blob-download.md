---
"@kamino/server": patch
---

A blob whose file is missing from storage now answers 404 `blob_missing` instead of breaking the download mid-stream; `blobs/check` reports it as missing and the next upload of the same content repairs it.
