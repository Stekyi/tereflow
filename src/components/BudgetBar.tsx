import { useEffect, useRef, useState } from 'react';
import { BUDGET_PRESETS } from '../../shared/budget';

/**
 * Set a working budget.
 *
 * Collapsed to a single line until it is wanted, because the reader who has
 * not thought about a budget yet should not be asked to before they have seen
 * anything worth budgeting for.
 *
 * Dollars only, and it says so. Trade figures arrive in dollars, and offering
 * a local currency would mean carrying an exchange rate that could go stale
 * and turn a real number into a wrong one without anybody noticing.
 */
export function BudgetBar({
  budget,
  onChange,
}: {
  budget: number;
  onChange: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(budget ? String(budget) : '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(budget ? String(budget) : '');
  }, [budget]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  function commit() {
    const n = Number(draft.replace(/[^0-9.]/g, ''));
    onChange(Number.isFinite(n) && n > 0 ? n : 0);
    setOpen(false);
  }

  if (!open) {
    return (
      <button type="button" className="budget-summary" onClick={() => setOpen(true)}>
        {budget > 0 ? (
          <>
            <span className="grow">
              Budget <strong>${budget.toLocaleString()}</strong>
            </span>
            <span className="tiny dim">Change</span>
          </>
        ) : (
          <>
            <span className="grow">Set a budget to see what it buys</span>
            <span className="tiny dim">Add</span>
          </>
        )}
      </button>
    );
  }

  return (
    <div className="budget-editor">
      <div className="row" style={{ gap: 8 }}>
        <span className="budget-currency">USD</span>
        <input
          ref={inputRef}
          className="budget-input"
          inputMode="decimal"
          placeholder="10000"
          aria-label="Budget in US dollars"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setOpen(false);
          }}
        />
        <button type="button" className="btn small" onClick={commit}>
          Done
        </button>
        {budget > 0 && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              onChange(0);
              setOpen(false);
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
        {BUDGET_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`chip${Number(draft) === p ? ' active' : ''}`}
            onClick={() => setDraft(String(p))}
          >
            ${p.toLocaleString()}
          </button>
        ))}
      </div>

      <p className="tiny dim" style={{ margin: '10px 0 0' }}>
        Quantities are goods value at the border, from the price each trade
        actually fetched. Freight, insurance, duty, clearing and financing sit on
        top of this.
      </p>
    </div>
  );
}
