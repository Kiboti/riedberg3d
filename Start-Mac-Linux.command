#!/bin/sh
# Riedberg 3D starten: lokaler Webserver + Echtzeit-Proxy (Python 3 nötig)
cd "$(dirname "$0")" || exit 1
URL=http://localhost:8080/
( sleep 1.5; if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"; fi ) &
exec python3 tools/serve.py 8080
