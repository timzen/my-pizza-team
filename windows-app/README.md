# Windows Tray App

A system tray app for Windows that manages the mpt daemon.

## Features

- 🍕 Pizza slice icon in the system tray
- Start/Stop daemon controls
- Team directory picker (folder browser dialog)
- Open UI in browser (double-click tray icon)
- Status polling (icon changes between active/inactive)

## Usage

1. Place `mpt.exe` (from the release) in this directory
2. Double-click `My Pizza Team.bat`

Or run directly:
```powershell
powershell -ExecutionPolicy Bypass -File tray.ps1
```

## Auto-Start on Login

To start automatically when you log in:

1. Press `Win+R`, type `shell:startup`, press Enter
2. Copy `My Pizza Team.bat` (and `mpt.exe` + `tray.ps1`) into that folder

Or create a shortcut to the bat file in the startup folder.

## Configuration

Set environment variables before running:
- `TEAM_DIR` — path to team directory
- `MPT_PORT` — daemon port (default: 7437)
