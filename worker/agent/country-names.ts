/**
 * Country names, re-exported.
 *
 * The list itself moved to shared/ because the CSV validator needs it and the
 * Worker agent is not on the client tsconfig's path. Re-exporting rather than
 * copying keeps one list: two would drift, and the second one to drift would
 * start accepting codes the first rejects.
 */
export { ISO3_NAME } from '../../shared/country-names';