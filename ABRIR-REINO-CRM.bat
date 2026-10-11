@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:4188
node server.cjs
pause
