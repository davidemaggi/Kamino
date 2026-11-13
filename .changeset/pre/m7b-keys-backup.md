---
"@kamino/server": minor
---

Master key rotation without downtime (`keys rotate`, with the old key in `KAMINO_MASTER_KEY_PREVIOUS[_FILE]` during the switch) and full backups: `backup create` (database and encrypted blobs in one ZIP, never the key), `backup verify` (restores into a temporary database and decrypts a sample of blobs) and `backup restore` onto an empty installation.
