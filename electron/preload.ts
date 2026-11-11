import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { Api, Platform } from '../shared/types';

function currentPlatform(): Platform {
  if (process.platform === 'darwin' || process.platform === 'win32') return process.platform;
  return 'linux';
}

const api: Api = {
  platform: currentPlatform(),
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  getMachines: () => ipcRenderer.invoke(IPC.getMachines),
  getOverview: (filters) => ipcRenderer.invoke(IPC.getOverview, filters),
  getProjects: (filters) => ipcRenderer.invoke(IPC.getProjects, filters),
  getProjectDetail: (project, filters) =>
    ipcRenderer.invoke(IPC.getProjectDetail, project, filters),
  onUsageUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.usageUpdated, listener);
    return () => {
      ipcRenderer.removeListener(IPC.usageUpdated, listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
