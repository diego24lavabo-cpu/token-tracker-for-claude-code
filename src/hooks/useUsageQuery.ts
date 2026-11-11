import { useEffect, useState } from 'react';

interface QueryState<T> {
  /** The fetcher that produced `data`; a different one means newer data is on its way. */
  source: (() => Promise<T>) | null;
  data: T | null;
  failed: boolean;
}

export interface UsageQuery<T> {
  /** The latest result. It stays in place while newer data loads, so pages do not flicker. */
  data: T | null;
  loading: boolean;
  failed: boolean;
}

/**
 * Loads usage data from the main process and loads it again when the logs change.
 * `fetcher` must keep its identity between renders (wrap it in `useCallback`): a new
 * identity means "the question changed".
 */
export function useUsageQuery<T>(fetcher: () => Promise<T>): UsageQuery<T> {
  const [state, setState] = useState<QueryState<T>>({ source: null, data: null, failed: false });

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      fetcher().then(
        (data) => {
          if (!cancelled) setState({ source: fetcher, data, failed: false });
        },
        (error: unknown) => {
          console.error('Could not load usage data', error);
          if (!cancelled) setState((previous) => ({ ...previous, source: fetcher, failed: true }));
        },
      );
    };

    load();
    const unsubscribe = window.api.onUsageUpdated(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [fetcher]);

  return { data: state.data, loading: state.source !== fetcher, failed: state.failed };
}
