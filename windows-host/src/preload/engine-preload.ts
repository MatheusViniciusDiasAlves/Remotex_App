/** Ponte segura (contextIsolation) entre a janela de mídia e o processo principal. */
import { contextBridge, ipcRenderer } from 'electron';
import type { EngineBridge, EngineCommand, EngineEvent } from '../shared/engine-ipc';

const bridge: EngineBridge = {
  onCommand(cb) {
    ipcRenderer.on('engine:command', (_e, cmd: EngineCommand) => cb(cmd));
  },
  emit(ev: EngineEvent) {
    ipcRenderer.send('engine:event', ev);
  },
  recChunk(sessionId: string, data: ArrayBuffer) {
    return ipcRenderer.invoke('engine:rec-chunk', sessionId, data);
  },
};

contextBridge.exposeInMainWorld('engineBridge', bridge);
