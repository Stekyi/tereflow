/**
 * End-to-end check of the product insight endpoint and the admin-editable
 * settings behind it.
 *   npm run dev:worker             (terminal 1)
 *   node scripts/e2e-insight.mjs   (terminal 2)
 *
 * The checks here exist because each one caught something real:
 *   - a score of 82 in the product list and 34 in the modal for one product
 *   - an import row opening on the country's token exports
 *   - a mis-declared weight pricing gold at 697,170 dollars a tonne, and
 *     dragging the world median that classified every other country
 *   - a settings table nothing actually read
 */
const BASE = process.env.TF_BASE ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.TF_ADMIN_TOKEN ?? 'local-dev-token';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

async function get(path, admin = false) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/json',
      ...(admin ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function send(path, method, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function main() {
  console.log('\nProduct insight and settings\n');

  // --- shape ---------------------------------------------------------------
  const list = await get('/api/products?limit=30');
  const products = list.body?.products ?? [];
  check('product list has rows to work from', products.length > 0, `${products.length} rows`);
  if (!products.length) {
    console.log('\nNo analysed products. Run the pipeline first.\n');
    process.exit(1);
  }

  const sample = products[0];

  /*
   * The figures above the list must describe the list.
   *
   * `count` used to report the size of the page rather than the number of
   * matches, so a caller asking for 20 of 339 was told there were 20.
   */
  const s20 = await get('/api/products?limit=20');
  const sum = s20.body?.summary ?? {};
  check('the product list carries a summary', typeof sum.total === 'number', JSON.stringify(sum));
  check(
    'count is the total, not the page size',
    s20.body?.count === sum.total && sum.total >= (s20.body?.products?.length ?? 0),
    `count ${s20.body?.count}, page ${s20.body?.products?.length}, total ${sum.total}`,
  );
  check(
    'exports and imports account for every opening',
    sum.exports + sum.imports === sum.total,
    `${sum.exports} + ${sum.imports} vs ${sum.total}`,
  );
  check('strong is a subset of the total', sum.strong <= sum.total, `${sum.strong}/${sum.total}`);

  const africa = await get('/api/products?limit=20&continent=Africa&flow=export');
  const af = africa.body?.summary ?? {};
  check(
    'the summary follows the filters the list follows',
    af.imports === 0 && af.total === af.exports && af.total <= sum.total,
    `africa exports ${af.total}, imports ${af.imports}, of ${sum.total} global`,
  );
  check(
    'every row returned matches the filter it was asked for',
    (africa.body?.products ?? []).every((p) => p.flow === 'export' && p.continent === 'Africa'),
  );
  const ins = await get(`/api/insight/${sample.hs_code}`);
  check('GET /api/insight/:hs responds', ins.status === 200, `status ${ins.status}`);
  const d = ins.body ?? {};

  check('carries the product identity', d.hs_code === sample.hs_code && !!d.name);
  check('names the sector and chapter', !!d.sector && !!d.chapter_label);
  check('returns seller and buyer arrays', Array.isArray(d.sellers) && Array.isArray(d.buyers));
  check('reports coverage honestly', typeof d.totals?.countries_with_data === 'number'
    && d.totals.reporting_countries <= d.totals.countries_with_data,
    `${d.totals?.reporting_countries} of ${d.totals?.countries_with_data}`);
  check('states whether partner detail exists', typeof d.partner_detail_available === 'boolean');
  check('has no gross margin field', !('gross_margin' in d) && !('margin_pct' in d));

  const badHs = await get('/api/insight/12345');
  check('rejects a malformed HS code', badHs.status === 400, `status ${badHs.status}`);

  /*
   * Every product in the list must open, not just a convenient one.
   *
   * This exists because D1 refuses a LIKE pattern over fifty characters, and
   * the subscriber search built its pattern from the product description. Any
   * product with a long name returned a bare 500. Cocoa and gold have short
   * names, so hand-checking missed it and roughly half the catalogue was
   * broken.
   */
  const broken = [];
  for (const p of products) {
    const r = await get(`/api/insight/${p.hs_code}`);
    if (r.status !== 200) broken.push(`${p.hs_code} (${r.status})`);
  }
  check(
    'every listed product opens, whatever its name length',
    broken.length === 0,
    broken.length ? broken.slice(0, 5).join(', ') : `${products.length} checked`,
  );

  const longest = products.reduce((a, b) => (b.name_full.length > a.name_full.length ? b : a));
  const longRes = await get(`/api/insight/${longest.hs_code}`);
  check(
    'the longest product name in the set opens',
    longRes.status === 200,
    `${longest.name_full.length} chars, status ${longRes.status}`,
  );

  // --- the score must not contradict the list ------------------------------
  const scoped = await get(
    `/api/insight/${sample.hs_code}?country=${encodeURIComponent(sample.slug)}&flow=${sample.flow}`,
  );
  const s = scoped.body ?? {};
  check('scoping to a country sets the focus', s.focus_slug === sample.slug, s.focus_name ?? 'none');
  check('scoped view follows the flow asked for', s.focus_flow === sample.flow, s.focus_flow);
  check(
    'scoped score matches the product list',
    s.score === sample.score,
    `list ${sample.score}, insight ${s.score}`,
  );
  check(
    'scoped value matches the product list',
    Math.abs((s.value_usd ?? 0) - sample.value_usd) < 1,
    `list ${sample.value_usd}, insight ${s.value_usd}`,
  );
  check(
    'a score is either absent or attributed',
    s.score == null || !!s.score_from_name,
    s.score_from_name ?? 'null',
  );

  // An import row must not open on the country's exports.
  const importRow = products.find((p) => p.flow === 'import');
  if (importRow) {
    const imp = await get(
      `/api/insight/${importRow.hs_code}?country=${encodeURIComponent(importRow.slug)}&flow=import`,
    );
    check(
      'an import row opens on import figures',
      imp.body?.focus_flow === 'import'
        && Math.abs((imp.body?.value_usd ?? 0) - importRow.value_usd) < 1,
      `${imp.body?.focus_flow}, ${imp.body?.value_usd} vs ${importRow.value_usd}`,
    );
  } else {
    check('an import row opens on import figures', true, 'no import row in sample, skipped');
  }

  // --- prices --------------------------------------------------------------
  const priced = [];
  for (const p of products.slice(0, 12)) {
    const r = await get(`/api/insight/${p.hs_code}`);
    if (r.body) priced.push(r.body);
  }

  check(
    'a premium band is only given with a ratio behind it',
    priced.every((x) => x.price_premium === 'unknown' || x.price_ratio != null),
  );
  check(
    'no price survives more than ten times off the median',
    priced.every((x) => x.price_ratio == null || (x.price_ratio <= 10.001 && x.price_ratio >= 0.0999)),
    priced.map((x) => x.price_ratio).filter((r) => r != null && (r > 10 || r < 0.1)).join(', ') || 'none',
  );
  check(
    'a borrowed price says whose it is',
    priced.every((x) => x.unit_value_usd_t == null || x.price_from_name !== undefined),
  );
  check(
    'unit values are positive where reported',
    priced.every((x) => x.unit_value_usd_t == null || x.unit_value_usd_t > 0),
  );
  check(
    'every listed seller value is a real number',
    priced.every((x) => x.sellers.every((r) => typeof r.value_usd === 'number' && r.value_usd >= 0)),
  );
  check(
    'ranks run from one without gaps',
    priced.every((x) => x.sellers.every((r, i) => r.rank === i + 1)),
  );

  // --- settings ------------------------------------------------------------
  const cfg = await get('/api/admin/portal/config', true);
  check('GET portal config responds', cfg.status === 200, `status ${cfg.status}`);
  const settings = cfg.body?.settings ?? [];
  check('settings are seeded', settings.length >= 20, `${settings.length} rows`);
  check(
    'every setting explains itself',
    settings.every((r) => r.name && r.description && r.description.length > 20),
  );
  check(
    'every setting carries a default to revert to',
    settings.every((r) => r.default_value != null && r.default_value !== ''),
  );
  check(
    'kinds stay inside the vocabulary the validator knows',
    settings.every((r) => ['number', 'count', 'text', 'percent', 'usd'].includes(r.kind)),
    [...new Set(settings.map((r) => r.kind))].join(', '),
  );

  const unauth = await fetch(`${BASE}/api/admin/portal/config`);
  check('portal config is admin only', unauth.status === 401, `status ${unauth.status}`);

  const numeric = settings.find((r) => r.kind !== 'text');
  if (numeric) {
    const junk = await send(`/api/admin/portal/config/${numeric.code}`, 'PUT', { value: 'abc' });
    check('a number setting refuses prose', junk.status === 400, `status ${junk.status}`);

    const original = numeric.value;
    const write = await send(`/api/admin/portal/config/${numeric.code}`, 'PUT', {
      value: String(Number(original) + 1),
    });
    check('a valid write is accepted', write.status === 200, `status ${write.status}`);

    const after = await get('/api/admin/portal/config', true);
    const row = (after.body?.settings ?? []).find((r) => r.code === numeric.code);
    check('the write is readable back', row?.value === String(Number(original) + 1), row?.value);
    check('a changed setting is flagged as changed', row?.changed === true);

    const reset = await send(`/api/admin/portal/config/${numeric.code}/reset`, 'POST');
    check('reset restores the default', reset.body?.value === numeric.default_value, reset.body?.value);

    const restored = await get('/api/admin/portal/config', true);
    const back = (restored.body?.settings ?? []).find((r) => r.code === numeric.code);
    check('the reset is durable', back?.value === numeric.default_value, back?.value);
  }

  const missing = await send('/api/admin/portal/config/NOT_A_SETTING', 'PUT', { value: '1' });
  check('an unknown setting is refused', missing.status === 404, `status ${missing.status}`);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
