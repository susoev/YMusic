const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  save: (patch) => ipcRenderer.send('player:save', patch),
  started: (id) => ipcRenderer.send('player:started', id),
  broken: (id) => ipcRenderer.send('player:broken', id),
  resize: (h) => ipcRenderer.send('resize', h),
  hide: () => ipcRenderer.send('hide'),
  login: () => ipcRenderer.send('login'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (text) => ipcRenderer.invoke('config:save', text),
  closeConfig: () => ipcRenderer.send('config:close'),
  on: (channel, cb) => {
    if (['tracks', 'status', 'config', 'cmd', 'history'].includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => cb(data));
    }
  },
});
