#!/bin/sh
set -e
if [ "$#" -eq 0 ]; then
  exec node dist/main.js
fi
exec node dist/cli/index.js "$@"
