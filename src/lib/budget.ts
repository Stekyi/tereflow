import { useCallback, useEffect, useState } from 'react';
import { BUDGET_STORAGE_KEY } from '../../shared/budget';

/**
 * The reader's working budget, in US dollars.
 *
 * Kept in localStorage rather than on the account so it works before anybody
 * signs up. Somebody weighing up whether to import something should not have
 * to register to find out what their money buys.
 *
 * Zero means not set, and every consumer treats that as "do not show budget
 * figures" rather than as a budget of nothing.
 */
export function useBudget(): [number, (n: number) => void] {
  const [budget, setBudget] = useState(0);

  useEffect(() => {
    const raw = localStorage.getItem(BUDGET_STORAGE_KEY);
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) setBudget(n);
  }, []);

  const update = useCallback((n: number) => {
    const safe = Number.isFinite(n) && n > 0 ? n : 0;
    setBudget(safe);
    if (safe) localStorage.setItem(BUDGET_STORAGE_KEY, String(safe));
    else localStorage.removeItem(BUDGET_STORAGE_KEY);
  }, []);

  return [budget, update];
}
