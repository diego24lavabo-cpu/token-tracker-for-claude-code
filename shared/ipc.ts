/** IPC channel names, shared by the main process and the preload script. */
export const IPC = {
  getAppInfo: 'app:get-info',
  getMachines: 'machines:list',
  usageUpdated: 'usage:updated',
} as const;
