/** Pure maths for national statistics series, shared so it can be tested without the Worker. */
/** Split a period into [year, position within the year]. */
function split(period: string): [number, number] {
  const y = Number(period.slice(0, 4));
  if (period.length === 4) return [y, 1];
  return [y, period.includes('Q') ? Number(period.slice(6)) : Number(period.slice(5))];
}

/** Year-to-date change of the latest year against the same periods a year earlier. Null unless both years cover the same periods. */
export function ytdGrowth(rows: { period: string; value_usd: number }[]): { pct: number; through: string; periods: number } | null {
  if (!rows.length) return null;
  const parsed = rows.map((r) => ({ y: split(r.period)[0], i: split(r.period)[1], v: r.value_usd, p: r.period }));
  const latest = parsed.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.i > a.i) ? b : a));
  const cur = parsed.filter((r) => r.y === latest.y && r.i <= latest.i);
  const prev = parsed.filter((r) => r.y === latest.y - 1 && r.i <= latest.i);
  const idx = (xs: typeof cur) => new Set(xs.map((x) => x.i));
  const a = idx(cur), b = idx(prev);
  if (a.size !== b.size || [...a].some((k) => !b.has(k))) return null;
  const pc = prev.reduce((s, r) => s + r.v, 0);
  if (pc <= 0) return null;
  return { pct: Math.round(((cur.reduce((s, r) => s + r.v, 0) / pc - 1) * 100) * 10) / 10, through: latest.p, periods: a.size };
}
