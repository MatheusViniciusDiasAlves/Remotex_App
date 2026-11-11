const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('target', { log: (ev) => ipcRenderer.send('log', ev) });
