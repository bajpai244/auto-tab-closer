<img src="icons/icon.svg" width="64" height="64" alt="Auto Tab Closer">

# Auto Tab Closer

A lightweight Chrome Extension (Manifest V3) that automatically closes inactive tabs and Chrome web apps (PWAs) once they exceed a configurable inactivity timer.

## Features

- **General Inactivity Timer (Default: 120 minutes)**: Configure any duration in minutes (with quick presets from `15m` to `8h`), synced across Chrome via `chrome.storage.sync`.
- **Tracks Both Tabs & Standalone Chrome Web Apps**: Monitors window focus changes in addition to tab switches, so idle background PWA/app windows are automatically closed too (optional toggle to keep active tabs in unfocused windows).
- **Smart Protections**:
  - Never closes the active tab in your currently focused window.
  - Protects pinned tabs (toggleable, on by default).
  - Protects tabs playing audio (toggleable, on by default).
  - Domain exclusion list (supports exact domains and subdomains, plus a 1-click exclude button for the current site).
- **Live Overview & Safety Net**:
  - View remaining countdowns for all open tabs and reset any tab's timer individually.
  - Reopen any recently auto-closed tab in one click from the **Closed** tab.
  - Pause/resume auto-closing anytime with an `OFF` badge indicator.

## Install in Chrome (Unpacked)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this repository folder (`auto-tab-closer`).
4. Pin **Auto Tab Closer** to the toolbar and click it to configure your timer (defaults to **120 minutes**).

## Run Tests

```bash
npm test
```
