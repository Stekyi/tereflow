/** UK import rules for one tariff line, read from the UK Trade Tariff API (no key). */
export interface RegulatorySummary {
  commodity_code: string;
  description: string;
  /** Standard duty for goods from countries with no trade agreement, as the tariff states it ("4.00 %", "26.00 GBP / hl"). */
  third_country_duty: string[];
  vat: string | null;
  /** Import controls, licences, quotas or prohibitions that apply to goods from everywhere. */
  controls: string[];
  /** A temporary suspension of the standard duty is in force. */
  duty_suspended: boolean;
  /** Countries and groups that have a preferential rate or quota of their own. */
  preference_areas: number;
  /** Restrictions that apply to goods from named countries only. */
  country_restrictions: { area: string; measure: string }[];
}

interface Item {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null } | undefined>;
}

const ERGA_OMNES = '1011';
const VAT_AREA = '1400';
const T_DUTY = '103';
const T_VAT = '305';
const T_SUSPENSION = '112';
const PREFERENCE = new Set(['142', '143', '145']);
const CONTROL = /control|licen[cs]e|prohibit|quota|ban\b|restriction/i;
const NOT_A_CONTROL = new Set([T_DUTY, T_VAT, T_SUSPENSION, '109', ...PREFERENCE]);
const MAX_RESTRICTIONS = 12;

export function parseCommodity(json: { data?: { attributes?: Record<string, unknown> }; included?: Item[] } | null): RegulatorySummary | null {
  if (!json?.data?.attributes || !Array.isArray(json.included)) return null;
  const by = (type: string) => new Map(json.included!.filter((x) => x.type === type).map((x) => [x.id, x]));
  const types = by('measure_type');
  const areas = by('geographical_area');
  const duties = by('duty_expression');
  const text = (m: Map<string, Item>, id: string | undefined, key: string) => (id ? String(m.get(id)?.attributes[key] ?? '') : '');

  const duty = new Set<string>();
  const controls = new Set<string>();
  const prefAreas = new Set<string>();
  const restr = new Map<string, { area: string; measure: string }>();
  let vat: string | null = null;
  let suspended = false;

  for (const m of json.included.filter((x) => x.type === 'measure' && x.attributes.import)) {
    const t = m.relationships?.measure_type?.data?.id;
    const a = m.relationships?.geographical_area?.data?.id;
    const d = m.relationships?.duty_expression?.data?.id;
    if (!t || !a) continue;
    const expr = text(duties, d, 'base').trim();
    if (t === T_DUTY && a === ERGA_OMNES && expr) duty.add(expr);
    else if (t === T_VAT && a === VAT_AREA && expr) vat = expr;
    else if (t === T_SUSPENSION && a === ERGA_OMNES) suspended = true;
    else if (PREFERENCE.has(t)) prefAreas.add(a);
    else if (!NOT_A_CONTROL.has(t)) {
      const name = text(types, t, 'description');
      if (!CONTROL.test(name)) continue;
      if (a === ERGA_OMNES) controls.add(name);
      else restr.set(`${a}|${name}`, { area: text(areas, a, 'description') || a, measure: name });
    }
  }
  const a = json.data.attributes;
  return {
    commodity_code: String(a.goods_nomenclature_item_id ?? ''),
    description: String(a.formatted_description ?? '').trim(),
    third_country_duty: [...duty],
    vat,
    controls: [...controls].sort(),
    duty_suspended: suspended,
    preference_areas: prefAreas.size,
    country_restrictions: [...restr.values()].sort((x, y) => x.area.localeCompare(y.area)).slice(0, MAX_RESTRICTIONS),
  };
}

export interface HeadingList {
  included?: { type: string; attributes: { goods_nomenclature_item_id?: string; declarable?: boolean } }[];
}

/**
 * The tariff is read per 10-digit line, while trade data is HS6 or HS8. Picks the first declarable line
 * that starts with the code, and says how many there are so the answer can be marked as one of several.
 */
export function pickCommodity(heading: HeadingList | null, hs: string): { code: string; lines: number } | null {
  const lines = (heading?.included ?? [])
    .filter((x) => x.type === 'commodity' && x.attributes.declarable && x.attributes.goods_nomenclature_item_id?.startsWith(hs))
    .map((x) => x.attributes.goods_nomenclature_item_id as string)
    .sort();
  return lines.length ? { code: lines[0], lines: lines.length } : null;
}
