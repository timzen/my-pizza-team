@echo off
REM My Pizza Team — Windows tray launcher
REM Starts the system tray app (hides console window)
powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tray.ps1"
