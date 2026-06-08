# AI Usage Dock — Claude Code Prompt

Paste prompt di bawah ini terus ke Claude Code dalam VS Code terminal atau chat panel.

---

## PROMPT (COPY SEMUA DARI SINI)

```
Saya mahu bina satu aplikasi desktop Windows yang berfungsi sebagai AI Usage Monitor Dock menggunakan Electron.js. Aplikasi ini mesti PORTABLE — iaitu tidak perlu install, hanya copy folder dan jalankan .exe terus.

---

## GAMBARAN PROJEK

Nama app: AiUsageDock
Teknologi: Electron.js + HTML + CSS + JavaScript (vanilla)
Output: Portable .exe (win-unpacked folder, guna electron-builder)
Platform: Windows 10/11

---

## STRUKTUR FOLDER PROJEK

Sila bina struktur seperti berikut:

ai-usage-dock/
├── src/
│   ├── main.js              # Electron main process
│   ├── preload.js           # Preload script (contextBridge)
│   ├── renderer/
│   │   ├── index.html       # UI utama widget
│   │   ├── style.css        # Styling widget
│   │   └── renderer.js      # UI logic & API calls
│   └── services/
│       ├── claudeUsage.js   # Fetch Claude usage data
│       ├── openaiUsage.js   # Fetch OpenAI usage data
│       └── copilotUsage.js  # Fetch GitHub Copilot usage data
├── config/
│   └── settings.json        # API keys & user settings (auto-create jika tiada)
├── package.json
├── electron-builder.yml     # Build config untuk portable
└── .gitignore

---

## SPESIFIKASI TETINGKAP (main.js)

Bina BrowserWindow dengan ciri-ciri berikut:

- width: 260, height: 480
- frame: false (tiada title bar Windows)
- transparent: true (background transparent)
- alwaysOnTop: true (float atas semua windows)
- resizable: false
- skipTaskbar: true (tidak muncul di taskbar)
- webPreferences:
  - contextIsolation: true
  - nodeIntegration: false
  - preload: path ke preload.js
- Posisi awal: sudut kanan atas desktop (gunakan screen.getPrimaryDisplay() untuk kira koordinat)
- Simpan posisi window dalam settings.json apabila window dipindahkan
- Load posisi tersimpan semasa app start

---

## FUNGSI DRAG (main.js + renderer.js)

- Implement drag menggunakan ipcMain/ipcRenderer
- Dari renderer: hantar koordinat mouse semasa drag ke main process
- Main process gerakkan window menggunakan win.setPosition(x, y)
- Simpan posisi akhir ke settings.json secara auto

---

## TRANSPARENCY CONTROL

- Slider dalam UI boleh adjust opacity window dari 20% hingga 100%
- Guna win.setOpacity(value) dari main process via IPC
- Simpan nilai opacity dalam settings.json

---

## UI DESIGN (index.html + style.css)

Ikut reka bentuk ini dengan tepat:

### Warna & Font
- Background widget: rgba(10, 14, 26, 0.92) dengan backdrop-filter blur
- Font header/nama: 'Syne' (Google Fonts)
- Font data/angka: 'JetBrains Mono' (Google Fonts)
- Skema warna gelap (dark theme sepenuhnya)
- Border: rgba(255,255,255,0.08)

### Header
- Icon bulat gradient (amber ke red): "⚡"
- Teks "AI USAGE" — Syne font, bold, uppercase, letter-spacing
- Jam live (HH:MM, update setiap minit)
- Butang refresh (↻) — animate rotate 360° on click
- Butang collapse/expand (▾/▸)

### Tab Bar
- 4 tabs: Claude | OpenAI | Copilot | All
- Tab aktif: background rgba(255,255,255,0.1), teks putih
- Tab tidak aktif: teks rgba(255,255,255,0.3)

### Setiap Service Panel mengandungi:
1. Header: logo kotak berwarna + nama service + badge plan
   - Claude logo: gradient #cc785c → #d4a574, huruf "C"
   - OpenAI logo: #10a37f, huruf "G"
   - Copilot logo: gradient #1f6feb → #388bfd, simbol "✦"
   - Badge: pill kecil dengan warna mengikut plan (Max=merah, Pro=hijau, Enterprise=biru)

2. Metric rows (untuk setiap metric seperti SESSION, WEEKLY, MODEL):
   - Label kecil uppercase dengan animated dot (pulse animation)
   - Nilai di kanan (contoh: "91% left")
   - Progress bar nipis (height: 3px) dengan warna gradient
   - Teks "resets in Xh Xm" di bawah bar (saiz sangat kecil)

3. Sparkline SVG chart untuk usage trend (animasi path drawing)

4. Cost footer:
   - Kiri: cost hari ini + 30 hari
   - Kanan: nilai dalam RM

### Panel "All" (overview semua services):
- Versi ringkas setiap service (logo + nama + % + mini progress bar)
- Token cell visualization (10 kotak, isi mengikut usage %)
- Total cost footer dengan breakdown per service

### Transparency Slider (di luar panel, fixed di bawah):
- Label "Transparency"
- Input range slider (amber thumb, glow effect)
- Nilai % di sebelah

### Animasi:
- Dot metric: pulse opacity 1 → 0.3 setiap 2 saat
- Progress bar: transition width 0.6s cubic-bezier
- Collapse/expand body: transition max-height 0.3s

---

## API INTEGRATION (services/)

### claudeUsage.js
Fetch dari Anthropic API untuk usage data:
- Endpoint: https://api.anthropic.com/v1/usage (jika wujud) ATAU kira dari conversation history
- Header: x-api-key: [dari settings.json]
- Jika endpoint tidak ada, tunjuk data simulasi dengan nota "Simulated — API key required"
- Return object: { session: { used, total, percent }, weekly: { used, total, percent }, model: 'claude-sonnet-4-6', cost: { today, month, myr } }

### openaiUsage.js
Fetch dari OpenAI usage API:
- Endpoint: https://api.openai.com/v1/usage
- Header: Authorization: Bearer [key dari settings.json]
- Return object: { session: { percent }, weekly: { percent }, model: 'gpt-4o', cost: { today, month, myr } }

### copilotUsage.js
Fetch dari GitHub API untuk Copilot usage:
- Endpoint: https://api.github.com/copilot/usage (enterprise) atau simulasi
- Header: Authorization: Bearer [GitHub token dari settings.json]
- Return object: { requests: { used, total, percent }, premium: { used, total }, model: 'claude-via-copilot', cost: { month, myr } }

NOTA: Jika mana-mana API tidak return data, fallback ke data simulasi yang realistik. Jangan crash app.

---

## SETTINGS (config/settings.json)

Auto-create fail ini dengan template jika tidak wujud:

```json
{
  "window": {
    "x": null,
    "y": null,
    "opacity": 0.92
  },
  "apiKeys": {
    "anthropic": "",
    "openai": "",
    "github": ""
  },
  "currency": {
    "code": "MYR",
    "rate": 4.71
  },
  "refreshInterval": 300000,
  "activeTab": "claude"
}
```

---

## IPC CHANNELS (preload.js + main.js)

Expose fungsi-fungsi ini kepada renderer via contextBridge:

```javascript
// preload.js expose:
window.electronAPI = {
  setOpacity: (value) => ipcRenderer.invoke('set-opacity', value),
  startDrag: () => ipcRenderer.send('start-drag'),
  onMouseMove: (callback) => ipcRenderer.on('mouse-moved', callback),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  closeApp: () => ipcRenderer.send('close-app'),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  fetchUsage: (service) => ipcRenderer.invoke('fetch-usage', service)
}

// main.js handle:
ipcMain.handle('set-opacity', (event, value) => win.setOpacity(value))
ipcMain.handle('save-settings', (event, settings) => { /* tulis ke settings.json */ })
ipcMain.handle('get-settings', () => { /* baca settings.json */ })
ipcMain.handle('fetch-usage', (event, service) => { /* call service module */ })
ipcMain.on('close-app', () => app.quit())
```

---

## SYSTEM TRAY (main.js)

Tambah system tray icon:
- Icon: bina icon 16x16 atau 32x32 PNG simple (boleh guna nativeImage.createFromDataURL dengan base64 PNG simple)
- Right-click menu: Show/Hide | Refresh | Settings | Quit
- Double-click tray: toggle show/hide window

---

## PACKAGE.JSON

```json
{
  "name": "ai-usage-dock",
  "version": "1.0.0",
  "description": "AI Usage Monitor Dock - Portable Windows App",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev",
    "build": "electron-builder --win portable",
    "build:dir": "electron-builder --win dir"
  },
  "devDependencies": {
    "electron": "^latest",
    "electron-builder": "^latest"
  },
  "dependencies": {
    "node-fetch": "^3.0.0"
  }
}
```

---

## ELECTRON-BUILDER.YML

```yaml
appId: com.luqman.aiusagedock
productName: AiUsageDock
directories:
  output: dist
win:
  target:
    - target: portable
      arch: [x64]
  icon: assets/icon.ico
portable:
  artifactName: AiUsageDock-portable.exe
nsis:
  oneClick: false
```

---

## AUTO-REFRESH

- Refresh data usage setiap 5 minit (300,000ms) secara auto
- Tunjuk masa "Last updated: HH:MM" dalam header
- Butang refresh manual ada dalam header
- Animate spinner semasa fetch berlaku

---

## ERROR HANDLING

- Jika API key kosong: tunjuk panel kecil "⚠ API key not set" dengan link buka settings.json
- Jika network error: tunjuk data terakhir dengan nota "Offline — showing cached data"
- Jika fetch gagal: fallback simulasi data, jangan crash

---

## ARAHAN BUILD (README dalam kod)

Tambah komen dalam package.json atau buat README.md ringkas:

```
# Setup
npm install

# Development (test run)
npm start

# Build portable .exe
npm run build

# Output ada di:
dist/AiUsageDock-portable.exe   ← single .exe portable
dist/win-unpacked/               ← folder portable (lebih laju start)
```

---

## PERMINTAAN AKHIR

1. Bina SEMUA fail yang diperlukan dengan kod lengkap
2. Pastikan app boleh run dengan `npm start` terus
3. Pastikan `npm run build` menghasilkan portable .exe
4. Semua teks dalam app adalah Bahasa Inggeris (untuk universal)
5. Komen dalam kod boleh dalam Bahasa Inggeris
6. Jangan tinggalkan placeholder — tulis kod penuh setiap fail
7. Jika ada dependency tambahan, nyatakan dalam package.json

Mulakan dengan main.js dahulu, kemudian preload.js, kemudian index.html + style.css, kemudian renderer.js, kemudian services/, kemudian package.json dan electron-builder.yml.
```

---

## CARA GUNA PROMPT INI

1. Buka **VS Code** dengan folder projek kosong baru
2. Buka **Claude Code** (terminal atau chat panel)
3. **Copy semua teks dalam blok kod di atas** (dari "Saya mahu bina..." hingga "...electron-builder.yml")
4. Paste ke Claude Code dan hantar
5. Claude Code akan bina semua fail satu per satu
6. Setelah siap, jalankan:
   ```bash
   npm install
   npm start
   ```
7. Untuk build portable .exe:
   ```bash
   npm run build
   ```

---

## FOLLOW-UP PROMPTS (jika perlu)

Jika Claude Code terhenti atau ada bahagian yang kurang, guna prompt tambahan ini:

**Jika UI kurang cantik:**
```
Perbaiki style.css supaya lebih menepati design asal — dark glassmorphism theme, progress bars 3px nipis, animated pulse dots, sparkline SVG charts, dan JetBrains Mono untuk semua angka.
```

**Jika transparency tidak berfungsi:**
```
Fix transparency issue — pastikan BrowserWindow ada transparent: true dan backgroundColor: '#00000000', dan win.setOpacity() dipanggil dengan betul dari IPC handler.
```

**Jika drag tidak berfungsi:**
```
Fix window drag — gunakan ipcMain untuk terima mouse event dari renderer dan panggil win.setPosition() dengan koordinat yang dikira dari screen.getCursorScreenPoint() tolak offset click asal.
```

**Jika build gagal:**
```
Fix electron-builder config — pastikan icon path betul, dan cuba build dengan `npx electron-builder --win dir` dahulu untuk test tanpa compress.
```
