/** Bundle entry for the Ghana pipeline. esbuild needs one file to start from. */
export { GhanaStatBankProvider } from '../worker/providers/ghana-statbank';
export { GHANA, ACTIVE_COUNTRIES } from '../worker/providers/countries/ghana';
export { computeMetrics } from '../worker/analytics/metrics';
export { buildOpportunities } from '../worker/analytics/opportunities';
