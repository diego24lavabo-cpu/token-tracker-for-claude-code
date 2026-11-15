import { useEffect, useState } from 'react';

/**
 * The current time, updated every half minute by default, for texts such as "4 min ago".
 * Pass a shorter interval for a countdown, and keep that in a small component of its own:
 * everything that reads it renders again at each tick.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
