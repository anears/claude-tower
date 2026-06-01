import { useState } from 'react';
import { getRateLimits, type RateLimits } from '../lib/usage.js';
import { usePolling } from './usePolling.js';
import { POLLING_INTERVALS } from '../constants.js';

export interface UseRateLimits {
  limits: RateLimits | undefined;
  reload: () => Promise<void>;
}

// Account-wide rate-limit windows (5h / 7d). The endpoint has its own in-memory
// cache (lib/rate-limits), so polling is cheap. Keep the last good value on a
// failed/empty fetch (only set when we actually got data).
export function useRateLimits(): UseRateLimits {
  const [limits, setLimits] = useState<RateLimits | undefined>();

  const reload = async (): Promise<void> => {
    const r = await getRateLimits();
    if (r) setLimits(r);
  };

  usePolling(reload, POLLING_INTERVALS.rateLimits);

  return { limits, reload };
}
