import { useEffect, useRef } from 'react';

// Runs `fn` on a recurring interval, scheduling the next run only after the
// previous one finishes (no overlap if a fetch runs long). The latest `fn`
// closure is always used via a ref, so callers don't need stable references.
// The first run happens after `intervalMs` — do the initial load separately.
export function usePolling(fn: () => Promise<void>, intervalMs: number): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        await fnRef.current();
      } catch {
        // swallow — a failed refresh shouldn't kill the loop
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };

    timer = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [intervalMs]);
}
