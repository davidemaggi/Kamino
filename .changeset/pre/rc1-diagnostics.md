---
"@kamino/server": patch
"@kamino/plugin": patch
---

Logs for troubleshooting: the server logs its version, commit and protocol at startup and every failing background job (name and error class only), the Docker compose files rotate container logs, and the plugin keeps a codes-only diagnostic log in its folder that the "Copy diagnostics" command and a button in the settings copy for a support request. Never paths, file names, contents or secrets.
