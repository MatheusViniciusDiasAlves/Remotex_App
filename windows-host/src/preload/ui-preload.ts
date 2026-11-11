/** Ponte segura entre o painel do host e o processo principal (sem Node no renderer). */
import { contextBridge, ipcRenderer } from 'electron';
import type { HostApi } from '../shared/ui-ipc';

const call =
  (name: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`ui:${name}`, ...args);

const api: HostApi = {
  getState: call('getState') as HostApi['getState'],
  onState(cb) {
    ipcRenderer.on('ui:state', (_e, s) => cb(s));
  },
  setIncoming: call('setIncoming') as any,
  setAttended: call('setAttended') as any,
  setUnattended: call('setUnattended') as any,
  setPassword: call('setPassword') as any,
  setPolicy: call('setPolicy') as any,
  setPasswordPermissions: call('setPasswordPermissions') as any,
  updateTrusted: call('updateTrusted') as any,
  revokeTrusted: call('revokeTrusted') as any,
  setDeviceName: call('setDeviceName') as any,
  setServerUrl: call('setServerUrl') as any,
  reregister: call('reregister') as any,
  setQuality: call('setQuality') as any,
  setAudio: call('setAudio') as any,
  setRecording: call('setRecording') as any,
  chooseRecordingDir: call('chooseRecordingDir') as any,
  setLaunchAtStartup: call('setLaunchAtStartup') as any,
  setRunInBackground: call('setRunInBackground') as any,
  setApprovalTimeout: call('setApprovalTimeout') as any,
  endSession: call('endSession') as any,
  stopRecording: call('stopRecording') as any,
  listRecordings: call('listRecordings') as any,
  openRecording: call('openRecording') as any,
  showRecordingsFolder: call('showRecordingsFolder') as any,
  deleteRecording: call('deleteRecording') as any,
  relaunchElevated: call('relaunchElevated') as any,
  copyId: call('copyId') as any,
  clearHistory: call('clearHistory') as any,
  decide: call('decide') as any,
  showMain: call('showMain') as any,
};

contextBridge.exposeInMainWorld('remotex', api);
