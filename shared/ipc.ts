/** IPC channel names, shared by the main process and the preload script. */
export const IPC = {
  getAppInfo: 'app:get-info',
  getMachines: 'machines:list',
  getOverview: 'usage:overview',
  getProjects: 'usage:projects',
  getProjectDetail: 'usage:project-detail',
  getModels: 'usage:models',
  getCalendar: 'usage:calendar',
  getSessions: 'usage:sessions',
  getSessionDetail: 'usage:session-detail',
  usageUpdated: 'usage:updated',
} as const;
