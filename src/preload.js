'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bridge a small, explicit API to the renderer. No Node access leaks through.
contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  getLaunchAtStartup: () => ipcRenderer.invoke('get-launch-at-startup'),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke('set-launch-at-startup', enabled),

  // Window
  setOpacity: (value) => ipcRenderer.invoke('set-opacity', value),
  resizeWindow: (height) => ipcRenderer.invoke('resize-window', height),
  setPeek: (peek) => ipcRenderer.send('set-peek', peek),
  setInteractive: (interactive) => ipcRenderer.send('set-interactive', interactive),
  closeApp: () => ipcRenderer.send('close-app'),
  hideApp: () => ipcRenderer.send('minimize-app'),

  // Data
  fetchUsage: (service) => ipcRenderer.invoke('fetch-usage', service),

  // Claude live session
  claudeLogin: (remember) => ipcRenderer.invoke('claude-login', remember),
  claudeImportSession: (key, remember) => ipcRenderer.invoke('claude-import-session', key, remember),
  claudeLogout: () => ipcRenderer.invoke('claude-logout'),
  claudeStatus: () => ipcRenderer.invoke('claude-status'),

  // Gemini live session
  geminiLogin: (remember) => ipcRenderer.invoke('gemini-login', remember),
  geminiImportSession: (key, remember) => ipcRenderer.invoke('gemini-import-session', key, remember),
  geminiLogout: () => ipcRenderer.invoke('gemini-logout'),
  geminiStatus: () => ipcRenderer.invoke('gemini-status'),

  // ChatGPT (OpenAI) live session
  openaiLogin: (remember) => ipcRenderer.invoke('openai-login', remember),
  openaiImportSession: (key, remember) => ipcRenderer.invoke('openai-import-session', key, remember),
  openaiLogout: () => ipcRenderer.invoke('openai-logout'),
  openaiStatus: () => ipcRenderer.invoke('openai-status'),

  // Shell
  openSettingsFile: () => ipcRenderer.send('open-settings-file'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Events from main / tray
  onTrayRefresh: (cb) => ipcRenderer.on('tray-refresh', () => cb()),
  onPeekChanged: (cb) => ipcRenderer.on('peek-changed', (_e, peeked) => cb(peeked)),
});
