@echo off
rem Riedberg 3D starten: lokaler Webserver + Echtzeit-Proxy (Python 3 noetig, https://www.python.org/downloads/)
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
start "" http://localhost:8080/
%PY% tools\serve.py 8080
if errorlevel 1 (
  echo.
  echo Python 3 wurde nicht gefunden oder Port 8080 ist belegt. Bitte Python 3 installieren ^(Haken "Add to PATH"^).
  pause
)
