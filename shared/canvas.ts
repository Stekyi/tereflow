import cfg from './config/canvas.json';

/**
 * Business Model Canvas, built deterministically from a Guide result plus the editable template lines in
 * shared/config/canvas.json. Nothing is invented: a line is either 'data' (taken from the Guide's own findings) or
 * 'typical' (standard practice from the config, labelled as such so the user knows to check it).
 */
export type Lang = 'en';
export type BlockKey = (typeof cfg.blocks)[number]['key'];
export interface Line { text: string; source: 'data' | 'typical' | 'user' }
export type Blocks = Record<string, Line[]>;

export interface CanvasInput {
  inputs: { country: string; product: string; hs: string; role: 'supply' | 'procurement'; budget_usd: number | null; iso3?: string | null };
  buyers?: { name: string; value_usd: number }[];
  suppliers?: { name: string; value_usd: number }[];
  chain?: { stage: string; actors: string[]; from_data: boolean }[];
  problems?: { title: string; research_questions: string[]; play: { title: string; how: string; when: string; risks: string[]; reward: string } }[];
  estimate?: { available: boolean; low_usd: number | null; high_usd: number | null } | null;
  risk?: { level: string; reasons: string[] } | null;
  fx?: { level: string; reason: string } | null;
  iso3?: string | null;
  /** Published finance figures for the country, when Tereflow holds them. Used only if present. */
  finance?: { lending?: { value: number; period: string }; policy?: { value: number; period: string }; lcFee?: { bank: string; value: number } } | null;
}

export const LANGS: Lang[] = cfg.languages as Lang[];
export const blockDefs = (lang: Lang) => cfg.blocks.map((b) => ({ key: b.key, label: b.label[lang], help: b.help[lang] }));

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? `{${k}}`);
const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString('en-US')}`);
const names = (xs?: { name: string }[], n = 4) => (xs ?? []).slice(0, n).map((x) => x.name).join(', ');
const dl = (key: string, lang: Lang) => (cfg.data_lines as Record<string, Record<string, string>>)[key][lang];

export function buildCanvas(g: CanvasInput, lang: Lang): Blocks {
  const role = g.inputs.role;
  const typ = (cfg.typical as Record<string, Record<string, Record<string, string[]>>>)[role];
  const vars = { product: g.inputs.product, country: g.inputs.country, iso3: g.inputs.iso3 ?? g.iso3 ?? '', buyers: names(g.buyers), suppliers: names(g.suppliers) };
  const T = (key: string): Line[] => (typ[key]?.[lang] ?? []).map((t) => ({ text: fill(t, vars), source: 'typical' as const }));
  const D = (text: string): Line => ({ text, source: 'data' });
  const out: Blocks = {};
  for (const b of cfg.blocks) out[b.key] = [];

  const top = g.problems?.[0];
  const marketList = role === 'supply' ? names(g.buyers) : names(g.suppliers);
  if (marketList) out.customer_segments.push(D(fill(dl(role === 'supply' ? 'buyers' : 'suppliers', lang), { list: marketList })));
  if (role === 'supply' && !marketList) out.customer_segments.push(D(`${g.inputs.country}: ${g.inputs.product} (HS ${g.inputs.hs})`));

  if (top) out.value_propositions.push(D(fill(dl('play_how', lang), { title: top.play.title, how: top.play.how })));
  if (top?.play.reward) out.value_propositions.push(D(fill(dl('play_reward', lang), { reward: top.play.reward })));

  out.channels.push(...T('channels'));
  out.customer_relationships.push(...T('customer_relationships'));

  out.revenue_streams.push(D(g.estimate?.available && g.estimate.low_usd != null && g.estimate.high_usd != null
    ? fill(dl('estimate', lang), { low: usd(g.estimate.low_usd), high: usd(g.estimate.high_usd) })
    : dl('estimate_none', lang)));

  out.key_resources.push(...T('key_resources'));
  out.key_activities.push(...T('key_activities'));
  for (const q of (top?.research_questions ?? []).slice(0, 3)) out.key_activities.push(D(fill(dl('question', lang), { q })));

  for (const c of (g.chain ?? []).filter((x) => x.from_data && x.actors.length)) {
    out.key_partnerships.push(D(fill(dl('chain_actors', lang), { stage: c.stage, actors: c.actors.slice(0, 4).join(', ') })));
  }
  out.key_partnerships.push(...T('key_partnerships'));

  out.cost_structure.push(...T('cost_structure'));
  for (const r of (top?.play.risks ?? []).slice(0, 3)) out.cost_structure.push(D(fill(dl('play_risk', lang), { risk: r })));
  const f = g.finance;
  if (f?.lending) {
    const rates = fill(dl('rate_names', lang), { lend: String(f.lending.value), lp: f.lending.period, pol: f.policy ? String(f.policy.value) : '', pp: f.policy ? f.policy.period : '' });
    out.cost_structure.push(D(fill(dl('finance_rates', lang), { country: g.inputs.country, rates: f.policy ? rates : rates.split(';')[0] })));
  }
  if (f?.lcFee) out.cost_structure.push(D(fill(dl('finance_fee', lang), { bank: f.lcFee.bank, fee: String(f.lcFee.value) })));
  if (g.fx?.reason) out.cost_structure.push(D(fill(dl('fx', lang), { reason: g.fx.reason })));
  if (g.risk?.level) out.cost_structure.push(D(fill(dl('risk', lang), { level: g.risk.level })));
  return out;
}

export function canvasToText(title: string, blocks: Blocks, lang: Lang, generated: string): string {
  const defs = blockDefs(lang);
  const lines = [title, 'Business Model Canvas (Osterwalder)', generated, ''];
  for (const d of defs) {
    lines.push(d.label.toUpperCase());
    for (const l of blocks[d.key] ?? []) lines.push(`- ${l.text}${l.source === 'typical' ? ' [typical]' : ''}`);
    lines.push('');
  }
  lines.push('[typical] = standard practice from the template, please check. Every other line comes from Tereflow data or from you.');
  return lines.join('\n');
}
