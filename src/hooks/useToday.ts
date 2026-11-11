import { useSyncExternalStore } from 'react';
import { localDay } from '../../shared/period';

const CHECK_INTERVAL_MS = 60_000;

function subscribe(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, CHECK_INTERVAL_MS);
  window.addEventListener('focus', onChange);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', onChange);
  };
}

const currentDay = () => localDay(new Date());

/** Today's local day (`YYYY-MM-DD`). The component renders again when the day changes. */
export function useToday(): string {
  return useSyncExternalStore(subscribe, currentDay);
}
