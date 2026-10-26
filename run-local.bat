@echo off
rem Starts Cleanify on this PC at http://127.0.0.1:8000/
cd /d "%~dp0"
start "" http://127.0.0.1:8000/
python -m http.server 8000 --bind 127.0.0.1
pause
