---
"@kamino/server": minor
"@kamino/plugin": minor
"@kamino/web": patch
---

Pairing with a QR code or a magic link: a device of the vault (or the web app) offers a one-time link valid ten minutes, the new device claims it, both show the same four-character code and the origin approves. The new device receives its token once; the server stores only hashes. The link can also be sent by email.
