@echo off
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
    py -3 frontdesk\server.py --open
) else (
    python frontdesk\server.py --open
)
if errorlevel 1 pause
