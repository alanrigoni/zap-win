'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zapwin', {
  getState: () => ipcRenderer.invoke('shell:get-state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onPrompt: (cb) => ipcRenderer.on('prompt', (_e, p) => cb(p)),
  select: (id) => ipcRenderer.send('shell:select', id),
  accountMenu: (id) => ipcRenderer.send('shell:account-menu', id),
  settingsMenu: () => ipcRenderer.send('shell:settings-menu'),
  setModal: (open) => ipcRenderer.send('shell:modal', open),
  saveAccount: (data) => ipcRenderer.invoke('shell:save-account', data),
  setBadges: (data) => ipcRenderer.send('shell:badges', data),
});
