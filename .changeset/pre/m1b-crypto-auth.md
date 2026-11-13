---
"@kamino/server": minor
"@kamino/web": minor
---

Real web authentication: first-run setup link, sign-in with Argon2id passwords and TOTP with recovery codes, cookie sessions with expiry and revocation, account settings and security log, CLI to create invitation and reset links and to reset 2FA. The server verifies the master key before running database migrations. Encryption module for vault keys, fields and blobs. The web app gains a hybrid development mode against the real server.
