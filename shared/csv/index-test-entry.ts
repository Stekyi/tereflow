/**
 * Single entry point for bundling the CSV layer into one module.
 *
 * esbuild needs one file to start from, and the test harness wants the reader,
 * the number parsing and the validator together. This exists only for that.
 */
export { parseCsv, parseNumber, parseYear, parsePeriod, normaliseHeader } from './parse';
export { validate } from './validate';
export { DATASETS, DATASET_CODES, datasetSpec, requiredColumns } from './schema';
