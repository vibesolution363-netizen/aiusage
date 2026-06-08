# AiUsageDock

A small, always-on-top **AI Usage Monitor Dock** for Windows 10/11, built with
Electron. Frameless, transparent, draggable, and **portable** — no installer,
just copy the folder and run the `.exe`.

It shows estimated usage for **Claude**, **OpenAI**, and **GitHub Copilot** with
session/weekly progress bars, sparkline trends, and cost (USD + MYR).

---

## Quick start (development)

```bash
npm install      # install Electron + electron-builder
npm start        # run the dock
```

Pass `--devtools` to open DevTools: `npm start -- --devtools`.

## Build a portable .exe

```bash
npm run build        # -> dist/AiUsageDock-portable.exe   (single portable .exe)
npm run build:dir    # -> dist/win-unpacked/               (folder, fastest start)
```

The `build` script regenerates the app icon first (`npm run make-icon`), then
runs `electron-builder`. The portable `.exe` is fully self-contained.

> If a build ever fails, try the unpacked target first: `npm run build:dir`.

### Troubleshooting: "Cannot create symbolic link … privilege is not held"

electron-builder downloads a `winCodeSign` archive that contains macOS symlinks.
Extracting them needs the **Create symbolic links** privilege, which a standard
Windows account doesn't have by default — so the build aborts even though the
Windows tooling it actually needs extracted fine.

Pick **one** of these (one-time):

1. **Enable Developer Mode** — Settings → *Privacy & security* → *For developers*
   → turn **Developer Mode** on. Then `npm run build` works without admin.
2. **Run the build from an elevated terminal** — open PowerShell/Terminal
   *as Administrator*, `cd` to the project, and run `npm run build`.

Either grants the symlink privilege for the extraction. This is an
electron-builder/Windows limitation, not an app issue — the app runs fine with
`npm start` regardless.

---

## Portability & settings

Settings (including your API keys, window position, and opacity) are stored in
a **plain JSON file next to the app**, so they travel with the folder:

| Mode                         | Settings location                                |
| ---------------------------- | ------------------------------------------------ |
| Dev (`npm start`)            | `config/settings.json`                           |
| Portable `.exe`              | `AiUsageDock-data/settings.json` next to the exe |
| Unpacked folder              | `AiUsageDock-data/settings.json` next to the exe |

The file is auto-created from a template on first run.

```json
{
  "window": { "x": null, "y": null, "opacity": 0.92 },
  "apiKeys": { "anthropic": "", "openai": "", "github": "" },
  "currency": { "code": "MYR", "rate": 4.71 },
  "refreshInterval": 300000,
  "activeTab": "claude"
}
```

Open it any time from the **tray → Edit settings.json**, or the
"⚠ API key not set" link inside a panel.

---

## Controls

- **Drag** the header to move the dock; position is saved automatically.
- **⚙** settings (Claude login + manual usage) · **↻** refresh now ·
  **▾ / ▸** collapse/expand · **×** hide to tray.
- **Transparency** slider (bottom) sets window opacity 20–100%.
- **Tray icon**: double-click to show/hide; right-click for Refresh / Settings / Quit.

---

## Claude usage — real data

Anthropic does **not** publish a REST endpoint for plan usage (session %, weekly
%). The dock gets **real** Claude numbers two ways, in priority order:

1. **Live (Option 1)** — Open **⚙ Settings → Log in to Claude**. A claude.ai
   window opens; sign in normally. The dock then runs the usage request *inside*
   the logged-in claude.ai page (so cookies / CSRF / Cloudflare all apply) and
   parses the result. Status shows **`Live · claude.ai`**.
2. **Manual (Option 2 · always accurate)** — In **⚙ Settings**, tick *Use manual
   values* and enter the **“% used”** shown on
   [claude.ai → Settings → Usage](https://claude.ai/settings/usage). Status shows
   **`Manual entry`**.

The displayed value is always *remaining*: **70% used → “30% left.”** The bar
fills to the used amount; only the small cost figure is an estimate (marked
`est.`).

If you're logged in but the live request can't be read, or you're not logged in
and have no manual values, the Claude panel shows a **Log in / Enter manually**
prompt instead of fake numbers.

> **Live endpoint not returning data?** Anthropic's internal endpoint isn't
> documented and changes over time. Find the real one in the claude.ai login
> window via DevTools → Network (look for a JSON response with usage/limit
> fields), then add its path to `claude.usageEndpoints` in `settings.json`
> (use `{org}` where the organization uuid belongs). Manual entry always works
> regardless.

### OpenAI & Copilot

Their consumer APIs also don't expose per-account usage %, so those two panels
show **estimated** figures and use your API key only to verify connectivity
(`Estimated — API connected` / `Simulated — API key required`). The app never
crashes on a failed network call.

---

## Project structure

```
ai-usage-dock/
├── src/
│   ├── main.js              # Electron main process (window, tray, IPC)
│   ├── preload.js           # contextBridge API
│   ├── renderer/            # index.html · style.css · renderer.js
│   └── services/            # claudeUsage · claudeLive (claude.ai scrape)
│                            # openaiUsage · copilotUsage · util
├── config/settings.json     # dev settings template
├── scripts/make-icon.js     # generates assets/icon.ico + icon.png
├── assets/                  # generated icon files
├── electron-builder.yml
└── package.json
```
