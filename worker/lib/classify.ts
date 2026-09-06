import type { ExportCategory, ExportClassification, ResolvedClassification } from '../../shared/types';
import { HS2_LABEL } from '../agent/codes';

/**
 * How much of a country's own exports its HS2 chapter must carry to count as
 * that country's own dominant legacy commodity (the algorithmic layer that
 * catches e.g. Ghanaian cocoa or Kenyan tea without hand-listing every
 * country). No separate "must also be top-3" condition is needed: at 25%+,
 * at most three chapters could ever qualify at once by construction.
 */
const DOMINANT_SHARE_THRESHOLD = 0.25;

/** Product rows are stored at the specific HS6 line; classification and the
 *  dominant-commodity heuristic both operate one level up, at the HS2
 *  chapter, since that's the level "traditional vs non-traditional" and
 *  "this is the country's headline commodity" are actually about. */
function chapterOf(hsCode: string): string {
  return hsCode.slice(0, 2);
}

/**
 * Loads every classification row that could apply to one country: the '*'
 * universal defaults (see migrations/0006_export_classification.sql) plus any
 * country-specific admin override, merged into one map keyed by hs_code with
 * the country-specific row winning when both exist.
 */
export async function loadClassifications(
  db: D1Database,
  entityId: string,
): Promise<Map<string, ExportClassification>> {
  const { results } = await db
    .prepare(`SELECT * FROM export_classifications WHERE entity_id IN ('*', ?) ORDER BY entity_id`)
    .bind(entityId)
    .all<ExportClassification>();

  // '*' rows sort first (ORDER BY entity_id: '*' < any ent_ id), so setting in
  // result order means a real entity row always overwrites the default.
  const resolved = new Map<string, ExportClassification>();
  for (const row of results ?? []) resolved.set(row.hs_code, row);
  return resolved;
}

/**
 * Bulk variant for routes that span many countries at once (e.g. /opportunities),
 * where a per-entity query per row would be one D1 round trip per country.
 * Loads the '*' defaults plus every listed entity's overrides in one query.
 */
export async function loadClassificationsBulk(
  db: D1Database,
  entityIds: string[],
): Promise<Map<string, Map<string, ExportClassification>>> {
  const ids = [...new Set(entityIds)];
  const { results } = await db
    .prepare(
      `SELECT * FROM export_classifications
        WHERE entity_id = '*'${ids.length ? ` OR entity_id IN (${ids.map(() => '?').join(',')})` : ''}`,
    )
    .bind(...ids)
    .all<ExportClassification>();

  const byEntity = new Map<string, Map<string, ExportClassification>>();
  for (const row of results ?? []) {
    if (!byEntity.has(row.entity_id)) byEntity.set(row.entity_id, new Map());
    byEntity.get(row.entity_id)!.set(row.hs_code, row);
  }
  return byEntity;
}

/** Merge one entity's overrides on top of the '*' defaults from a bulk load. */
export function resolveForEntity(
  byEntity: Map<string, Map<string, ExportClassification>>,
  entityId: string,
): Map<string, ExportClassification> {
  const merged = new Map(byEntity.get('*') ?? []);
  for (const [hs, row] of byEntity.get(entityId) ?? []) merged.set(hs, row);
  return merged;
}

/**
 * A country's own dominant legacy commodities: HS2 chapters that carry an
 * outsized share of everything it sells. Takes the full chapter-share
 * breakdown computed in analyse.ts (Overview.export_chapter_shares), not a
 * truncated top-N list, or a chapter split across products just outside the
 * displayed top could be undercounted.
 */
export function dominantCodes(exportChapterShares: Record<string, number> | undefined): Set<string> {
  if (!exportChapterShares) return new Set();
  return new Set(
    Object.entries(exportChapterShares)
      .filter(([, share]) => share >= DOMINANT_SHARE_THRESHOLD)
      .map(([chapter]) => chapter),
  );
}

/** hsCode may be a specific HS6 product line or a bare HS2 chapter (the product
 *  search can pass a chapter) -- classification always resolves at chapter level. */
export function classify(
  hsCode: string | null,
  resolved: Map<string, ExportClassification>,
  dominant: Set<string>,
): ExportCategory {
  if (!hsCode) return 'non_traditional';
  const chapter = chapterOf(hsCode);
  const row = resolved.get(chapter);
  if (row) return row.category;
  return dominant.has(chapter) ? 'traditional' : 'non_traditional';
}

function classificationSource(
  hsCode: string,
  resolved: Map<string, ExportClassification>,
  dominant: Set<string>,
): ResolvedClassification['source'] {
  const chapter = chapterOf(hsCode);
  const row = resolved.get(chapter);
  if (row) return row.entity_id === '*' ? 'default' : 'override';
  return dominant.has(chapter) ? 'heuristic' : 'default';
}

/** The full ~97-chapter resolved view for the admin curation screen. */
export function resolveAll(
  resolved: Map<string, ExportClassification>,
  dominant: Set<string>,
): ResolvedClassification[] {
  return Object.entries(HS2_LABEL).map(([code, label]) => {
    const row = resolved.get(code) ?? null;
    return {
      hs_code: code,
      label,
      category: classify(code, resolved, dominant),
      source: classificationSource(code, resolved, dominant),
      override: row && row.entity_id !== '*' ? row : null,
    };
  });
}
