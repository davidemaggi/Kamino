---
"@kamino/plugin": patch
---

A file replaced by the plugin (for example "keep incoming" on a conflict) could vanish from the device: the moment the old copy was set aside in the plugin's folder was taken for the user moving it there. The plugin now ignores its own folder in renames, and a device already affected downloads the file again (never deletes it).
