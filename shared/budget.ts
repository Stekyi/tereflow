/**
 * What a budget buys.
 *
 * This is arithmetic on two real numbers: a budget the reader typed, and a
 * unit value derived from reported trade value divided by reported weight. It
 * is not an estimate, a forecast, or advice.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * The dashboard this borrows the idea from shows an "estimated starting order"
 * and a margin alongside. Neither is available here and neither is guessable.
 * A starting order is a commercial judgement about minimums, shelf life and
 * container economics, and margin needs a cost basis the trade sources do not
 * carry: they report what a shipment fetched, not what it cost to put there.
 *
 * So this answers one question honestly rather than three questions loosely:
 * at the price this trade actually fetched, how much of it does your money
 * buy at the border. Freight, insurance, duty, clearing and financing all sit
 * on top and are the reader's to find out.
 *
 * Everything is in US dollars because every figure in the trade sources is.
 * Converting would need an exchange rate, and a rate that went stale would
 * quietly turn a real number into a wrong one.
 */

/** Kilograms in a tonne, named so the conversions below read as intent. */
const KG_PER_TONNE = 1000;

export interface BudgetFit {
  /** Tonnes the budget buys at this unit value. Null when no price is known. */
  tonnes: number | null;
  /** The same quantity in kilograms, for goods that trade in small volumes. */
  kg: number | null;
  /** What one tonne costs, carried through so callers need not recompute. */
  usd_per_tonne: number | null;
  /**
   * Whether the budget clears the bar below. Null when no price is known,
   * which is not the same as false: unknown is unknown.
   */
  fits: boolean | null;
}

/**
 * The smallest budget worth calling a fit.
 *
 * A budget that buys forty kilograms of machinery is arithmetically correct
 * and commercially meaningless, and showing it as a fit would flatter the
 * number. One tonne is a plain, defensible floor: below it the reader is not
 * looking at a trade, and the honest answer is that this budget does not
 * reach this product.
 */
export const MIN_VIABLE_TONNES = 1;

export function budgetFit(budgetUsd: number, unitValueUsdT: number | null): BudgetFit {
  if (!unitValueUsdT || unitValueUsdT <= 0 || !budgetUsd || budgetUsd <= 0) {
    return { tonnes: null, kg: null, usd_per_tonne: unitValueUsdT ?? null, fits: null };
  }
  const tonnes = budgetUsd / unitValueUsdT;
  return {
    tonnes,
    kg: tonnes * KG_PER_TONNE,
    usd_per_tonne: unitValueUsdT,
    fits: tonnes >= MIN_VIABLE_TONNES,
  };
}

/**
 * Quantity as a person would say it.
 *
 * Tonnes for anything of size, kilograms below that, because "0.04 t" reads
 * as nothing while "40 kg" reads as forty kilograms.
 */
export function fmtQuantity(fit: BudgetFit): string | null {
  if (fit.tonnes == null || fit.kg == null) return null;
  if (fit.tonnes >= 1000) return `${Math.round(fit.tonnes).toLocaleString()} t`;
  if (fit.tonnes >= 10) return `${fit.tonnes.toFixed(0)} t`;
  if (fit.tonnes >= 1) return `${fit.tonnes.toFixed(1)} t`;
  if (fit.kg >= 1) return `${Math.round(fit.kg).toLocaleString()} kg`;
  return 'less than a kilo';
}

/** Budgets offered as one tap, spanning a first shipment to a container load. */
export const BUDGET_PRESETS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];

export const BUDGET_STORAGE_KEY = 'tf_budget_usd';
