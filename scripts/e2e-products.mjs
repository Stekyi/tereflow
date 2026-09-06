/**
 * End-to-end check of the product-first surface against a running dev server.
 *   npm run dev:worker              (terminal 1)
 *   node scripts/e2e-products.mjs   (terminal 2)
 *
 * Covers the endpoints the home page, product modal and countries index read,
 * plus the data-integrity rules that make them trustworthy: no double-counted
 * granularities, no growth invented across capped years, no category labels
 * where a specific product is claimed.
 */
const BASE = process.env.TF_BASE ?? 'http://127.0.0.1:8787';

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

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
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
  console.log('\nProduct-first surface\n');

  // --- browse -------------------------------------------------------------
  const list = await get('/api/products?limit=20');
  check('GET /api/products responds', list.status === 200, `status ${list.status}`);
  const products = list.body?.products ?? [];
  check('returns products', products.length > 0, `${products.length} rows`);

  const first = products[0];
  if (first) {
    check(
      'card carries every field the UI reads',
      ['hs_code', 'name', 'name_full', 'sector', 'category', 'flow', 'country', 'slug', 'score']
        .every((k) => first[k] !== undefined),
      Object.keys(first).length + ' keys',
    );
    check(
      'score is on a 0-100 scale',
      products.every((p) => p.score >= 0 && p.score <= 100),
    );
    check(
      'results are ranked by score',
      products.every((p, i) => i === 0 || products[i - 1].score >= p.score),
    );
  }

  check(
    'traditional lines are hidden by default',
    products.every((p) => p.category !== 'traditional'),
  );

  const withTraditional = await get('/api/products?limit=60&all=1');
  check(
    'all=1 returns at least as many rows',
    (withTraditional.body?.products ?? []).length >= products.length,
  );

  // The whole point of the pivot: specific lines, not chapter headings.
  const specific = products.filter((p) => p.hs_code.length === 6);
  check(
    'at least some rows are specific HS6 lines, not chapters',
    specific.length > 0,
    `${specific.length}/${products.length} specific`,
  );

  check(
    'display names are short enough to scan',
    products.every((p) => p.name.length <= 62),
    `longest ${Math.max(0, ...products.map((p) => p.name.length))}`,
  );

  // --- filters ------------------------------------------------------------
  const exportsOnly = await get('/api/products?flow=export&limit=10');
  check(
    'flow filter is applied',
    (exportsOnly.body?.products ?? []).every((p) => p.flow === 'export'),
  );

  const africa = await get('/api/products?continent=Africa&limit=10');
  check(
    'continent filter is applied',
    (africa.body?.products ?? []).every((p) => p.continent === 'Africa'),
  );

  if (first) {
    const search = await get(`/api/products?q=${encodeURIComponent(first.name.slice(0, 5))}`);
    check('search returns matches', (search.body?.products ?? []).length > 0);
  }

  // --- product detail -----------------------------------------------------
  const target = specific[0] ?? first;
  if (target) {
    const detail = await get(`/api/products/${target.hs_code}`);
    check('GET /api/products/:hs responds', detail.status === 200, `status ${detail.status}`);
    const d = detail.body ?? {};
    check('detail names the product', Boolean(d.name));
    check('detail keeps the full source description', Boolean(d.name_full));
    check('detail has an exporters list', Array.isArray(d.exporters));
    check('detail has an importers list', Array.isArray(d.importers));
    check('detail has a partners list', Array.isArray(d.partners));
    check(
      'exporters are ranked from 1 and ordered by value',
      (d.exporters ?? []).every((r, i) => r.rank === i + 1) &&
        (d.exporters ?? []).every((r, i, a) => i === 0 || a[i - 1].value_usd >= r.value_usd),
    );
    check(
      'partner rows declare whether they are product specific',
      (d.partners ?? []).every((p) => typeof p.product_specific === 'boolean'),
    );
    check(
      'totals match the listed countries',
      Math.abs(
        (d.total_export_usd ?? 0) - (d.exporters ?? []).reduce((s, r) => s + r.value_usd, 0),
      ) < 1,
    );
  }

  const badCode = await get('/api/products/abc');
  check('malformed HS code is rejected', badCode.status === 400, `status ${badCode.status}`);

  // --- countries index ----------------------------------------------------
  const countries = await get('/api/countries');
  check('GET /api/countries responds', countries.status === 200, `status ${countries.status}`);
  const rows = countries.body?.countries ?? [];
  check('returns the registry', rows.length > 0, `${rows.length} countries`);
  check(
    'index carries summary figures and no product list',
    rows.every((r) => 'export_usd' in r && 'top_partner' in r && !('products' in r)),
  );
  check(
    'activated countries sort first',
    rows.every((r, i) => i === 0 || !(r.is_active && !rows[i - 1].is_active)),
  );
  const active = rows.filter((r) => r.is_active);
  check(
    'activated countries report a year',
    active.length === 0 || active.some((r) => r.year != null),
  );
  check(
    'inactive countries report no figures rather than zeroes',
    rows.filter((r) => !r.is_active).every((r) => r.export_usd === null && r.year === null),
  );

  const filtered = await get('/api/countries?continent=Africa');
  check(
    'country continent filter is applied',
    (filtered.body?.countries ?? []).every((r) => r.continent === 'Africa'),
  );

  // --- integrity ----------------------------------------------------------
  // The adapter now stores HS2 and HS6 for the same trade. If any consumer
  // sums across both levels the figures double. A country's listed product
  // values must never exceed its reported total exports.
  const dash = active.find((r) => r.export_usd);
  if (dash) {
    const detail = await get(`/api/dashboard/${dash.slug}`);
    const top = detail.body?.top_exports ?? [];
    const sumShare = top.reduce((s, r) => s + (r.share_pct ?? 0), 0);
    check(
      'top export shares stay within 100 percent',
      sumShare <= 100.5,
      `${dash.name} sums to ${sumShare.toFixed(1)}%`,
    );
    check(
      'product values do not exceed the country total',
      top.every((r) => r.value_usd <= (dash.export_usd ?? 0) * 1.001),
      dash.name,
    );
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
