'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Bridge a small, explicit API to the renderer. No Node access leaks through.
contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),

  // Window
  setOpacity: (value) => ipcRenderer.invoke('set-opacity', value),
  resizeWindow: (height) => ipcRenderer.invoke('resize-window', height),
  startDrag: (offset) => ipcRenderer.send('drag-start', offset),
  endDrag: () => ipcRenderer.send('drag-end'),
  closeApp: () => ipcRenderer.send('close-app'),
  hideApp: () => ipcRenderer.send('minimize-app'),

  // Data
  fetchUsage: (service) => ipcRenderer.invoke('fetch-usage', service),

  // Claude live session (Option 1)
  claudeLogin: () => ipcRenderer.invoke('claude-login'),
  claudeLogout: () => ipcRenderer.invoke('claude-logout'),
  claudeStatus: () => ipcRenderer.invoke('claude-status'),

  // Shell
  openSettingsFile: () => ipcRenderer.send('open-settings-file'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Events from main / tray
  onTrayRefresh: (cb) => ipcRenderer.on('tray-refresh', () => cb()),
});
