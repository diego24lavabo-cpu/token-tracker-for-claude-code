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
  getProjectDetail: (project, filters, folder) =>
    ipcRenderer.invoke(IPC.getProjectDetail, project, filters, folder === true),
  getModels: (filters) => ipcRenderer.invoke(IPC.getModels, filters),
  getCalendar: (machineIds) => ipcRenderer.invoke(IPC.getCalendar, machineIds),
  getSessions: (filters, page, sort) => ipcRenderer.invoke(IPC.getSessions, filters, page, sort),
  getSessionDetail: (machineId, sessionId) =>
    ipcRenderer.invoke(IPC.getSessionDetail, machineId, sessionId),
  getAgents: (filters) => ipcRenderer.invoke(IPC.getAgents, filters),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch) => ipcRenderer.invoke(IPC.setSettings, patch),
  addLogFolder: () => ipcRenderer.invoke(IPC.addLogFolder),
  removeLogFolder: (folder) => ipcRenderer.invoke(IPC.removeLogFolder, folder),
  scanNow: () => ipcRenderer.invoke(IPC.scanNow),
  exportCsv: (kind, filters) => ipcRenderer.invoke(IPC.exportCsv, kind, filters),
  rebuildDatabase: () => ipcRenderer.invoke(IPC.rebuildDatabase),
  keepHistoryLonger: () => ipcRenderer.invoke(IPC.keepHistoryLonger),
  onUsageUpdated: (callback) => {
    const listener = () => callback();
    ipcRenderer.on(IPC.usageUpdated, listener);
    return () => {
      ipcRenderer.removeListener(IPC.usageUpdated, listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
