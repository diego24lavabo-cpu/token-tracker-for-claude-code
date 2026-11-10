import type { Api } from '../shared/types';

declare global {
  interface Window {
    /** Exposed by electron/preload.ts through contextBridge. */
    api: Api;
  }
}

export {};
