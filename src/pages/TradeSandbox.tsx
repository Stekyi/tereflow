import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { usePageTitle } from '../lib/pageTitle';
import { Empty, Skeletons } from '../components/ui';
import type { Entity } from '../../shared/types';
import { ISO3_NAME } from '../../shared/country-names';
import type { TradeSandboxPartner, TradeSandboxProduct, TradeSandboxProductTotal, TradeSandboxResponse } from '../../shared/trade-sandbox';

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const money = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}bn` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${nf.format(n)}`;
const NO_TRANSACTION = 'No recorded transaction';

type ProductRow = TradeSandboxProduct & { cagr: number | null; share: number | null };

type ProductTrendPoint = {
  year: number;
  partner_usd: number | null;
  total_usd: number | null;
};

function marketShare(partner: number | null, total: number | null): number | null {
  if (partner == null || total == null || !(total > 0)) return null;
  return (partner / total) * 100;
}

function shareText(share: number | null): string {
  return share == null ? 'Not available' : `${share.toFixed(1)}%`;
}

function observed(value: number | null): string {
  return value == null ? NO_TRANSACTION : money(value);
}

export default function TradeSandbox() {
  usePageTitle('Trade sandbox');
  const [searchParams] = useSearchParams();
  const requestedHs = searchParams.get('hs');
  const requestedPartner = searchParams.get('partner')?.toUpperCase() ?? '';
  const requestedFlow = searchParams.get('flow') === 'import' || searchParams.get('flow') === 'export'
    ? searchParams.get('flow') as 'import' | 'export'
    : null;
  const [countries, setCountries] = useState<Entity[]>([]);
  const [primary, setPrimary] = useState(searchParams.get('primary') ?? '');
  const [partners, setPartners] = useState<string[]>(requestedPartner ? [requestedPartner] : []);
  const [partnerSearch, setPartnerSearch] = useState('');
  const [result, setResult] = useState<TradeSandboxResponse | null>(null);
  // Traditional trade (gold, oil, metals and the like) is hidden unless the reader asks to see it.
  const [showTraditional, setShowTraditional] = useState(false);
  const [loadingCountries, setLoadingCountries] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.entities({ kind: 'country', all: '1' })
      .then((r) => {
        const active = r.entities.filter((e) => e.kind === 'country' && e.is_active === 1 && e.iso3);
        setCountries(active);
        if (!primary && active.length) {
          const requested = active.find((country) => country.slug === searchParams.get('primary'));
          setPrimary(requested?.slug ?? active[0].slug);
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingCountries(false));
  }, []);

  const primaryIso3 = countries.find((c) => c.slug === primary)?.iso3 ?? '';
  const partnerOptions = useMemo(
    () => Object.entries(ISO3_NAME)
      .filter(([iso3]) => iso3 !== primaryIso3)
      .map(([iso3, name]) => ({ iso3, name })),
    [primaryIso3],
  );

  useEffect(() => {
    setPartners((current) => current.filter((iso3) => iso3 !== primaryIso3 && partnerOptions.some((p) => p.iso3 === iso3)));
  }, [primaryIso3, partnerOptions]);

  async function initiate() {
    if (!primary || partners.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await api.tradeSandbox(primary, partners, showTraditional));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the trade comparison');
    } finally {
      setRunning(false);
    }
  }

  if (loadingCountries) return <Skeletons n={5} />;

  return (
    <>
      <div className="hero tight">
        <div className="row between" style={{ gap: 12, alignItems: 'flex-start' }}>
          <div>
            <p className="overline">Explore bilateral trade</p>
            <h2>Trade Sandbox</h2>
            <p>
              Select an activated country as the primary reporter, then compare it with any country in the world.
              Tereflow queries the primary country's ingested trade data for the selected partner.
            </p>
          </div>
          <Link className="btn" to="/countries">Countries</Link>
        </div>
      </div>

      <div className="card">
        <div className="sandbox-grid">
          <section>
            <p className="card-title">Primary country</p>
            <p className="tiny dim">The reporter on the left.</p>
            <select
              className="sandbox-select"
              value={primary}
              onChange={(e) => {
                setPrimary(e.target.value);
                setResult(null);
                setError(null);
              }}
            >
              {countries.map((c) => <option key={c.slug} value={c.slug}>{c.name} ({c.iso3})</option>)}
            </select>
          </section>

          <section>
            <p className="card-title">Compare with</p>
            <p className="tiny dim">Any country can be selected. If the primary country has no transaction with it, the result will say so.</p>
            <input
              className="sandbox-select"
              value={partnerSearch}
              onChange={(e) => setPartnerSearch(e.target.value)}
              placeholder="Search country or ISO3"
              aria-label="Search comparison countries"
              style={{ marginBottom: 8 }}
            />
            <div className="sandbox-partners">
              {partnerOptions.length === 0 ? (
                <div className="callout warn">No countries are available.</div>
              ) : partnerOptions.filter((c) => `${c.name} ${c.iso3}`.toLowerCase().includes(partnerSearch.trim().toLowerCase())).slice(0, 30).map((c) => (
                <label key={c.iso3} className="sandbox-check">
                  <input
                    type="checkbox"
                    checked={partners.includes(c.iso3)}
                    onChange={(e) => setPartners((old) => e.target.checked ? [...old, c.iso3] : old.filter((x) => x !== c.iso3))}
                  />
                  <span><strong>{c.name}</strong><span className="tiny dim"> {c.iso3}</span></span>
                </label>
              ))}
            </div>
          </section>
        </div>

        <label className="sandbox-check" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={showTraditional}
            onChange={(e) => {
              setShowTraditional(e.target.checked);
              setResult(null);
            }}
          />
          <span>
            Include traditional trade (gold, oil, metals and similar)
            <span className="tiny dim"> Hidden by default: large licensed or state-controlled lines that a small company cannot enter.</span>
          </span>
        </label>

        <button className="btn primary" type="button" disabled={!primary || partners.length === 0 || running} onClick={initiate} style={{ marginTop: 16 }}>
          {running ? 'Building trade view…' : 'Initiate Tere'}
        </button>
        {error && <p className="tiny down" style={{ marginTop: 10 }}>{error}</p>}
      </div>

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="card">
            <p className="card-title">{result.primary.name} bilateral trade</p>
            <p className="tiny dim">Years: {result.years.join(' · ')}</p>
            <p className="tiny dim">{result.note}</p>
            {!showTraditional && (result.excluded_codes ?? 0) > 0 && (
              <p className="tiny dim">
                Traditional trade is hidden from these totals and product lists. Tick the box above and run it again to include it.
              </p>
            )}
          </div>
          {result.partners.map((partner) => (
            <PartnerResult
              key={partner.slug}
              partner={partner}
              primaryName={result.primary.name}
              primaryProductTotals={result.primary_product_totals ?? []}
              requestedHs={requestedHs}
              requestedFlow={requestedFlow}
            />
          ))}
        </div>
      )}
    </>
  );
}

function PartnerResult({
  partner,
  primaryName,
  primaryProductTotals,
  requestedHs,
  requestedFlow,
}: {
  partner: TradeSandboxPartner;
  primaryName: string;
  primaryProductTotals: TradeSandboxProductTotal[];
  requestedHs: string | null;
  requestedFlow: 'import' | 'export' | null;
}) {
  const [flow, setFlow] = useState<'all' | 'export' | 'import'>('all');
  const [product, setProduct] = useState<ProductRow | null>(null);
  const observedYears = partner.products.map((row) => row.year);
  const [selectedYear, setSelectedYear] = useState(
    observedYears.length ? Math.max(...observedYears) : partner.years[partner.years.length - 1],
  );
  useEffect(() => {
    if (product || !requestedHs || !requestedFlow) return;
    const match = partner.products.find((row) => row.hs_code === requestedHs && row.flow === requestedFlow);
    if (match) setSelectedYear(match.year);
  }, [partner.products, product, requestedHs, requestedFlow]);

  const latest = partner.years[partner.years.length - 1];
  const previous = partner.years[0];
  const latestTotals = partner.totals.find((x) => x.year === latest);
  const oldTotals = partner.totals.find((x) => x.year === previous);
  const growth = (a: number | null | undefined, b: number | null | undefined) =>
    a != null && b != null && b > 0 ? ((a / b) ** (1 / Math.max(1, latest - previous)) - 1) * 100 : null;

  const totalByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of primaryProductTotals) map.set(`${row.year}|${row.flow}|${row.hs_code}`, row.value_usd);
    return map;
  }, [primaryProductTotals]);

  const productRows = useMemo(() => {
    const byKey = new Map<string, TradeSandboxProduct[]>();
    for (const row of partner.products) {
      if (row.partner_iso3 !== partner.iso3) continue;
      if (flow !== 'all' && row.flow !== flow) continue;
      const key = `${row.flow}|${row.hs_code}`;
      const arr = byKey.get(key) ?? [];
      arr.push(row);
      byKey.set(key, arr);
    }

    return [...byKey.values()]
      .map((rows) => {
        const sorted = [...rows].sort((a, b) => a.year - b.year);
        const selectedRows = sorted.filter((row) => row.year === selectedYear);
        if (!selectedRows.length) return null;
        const selected = selectedRows[0];
        const value = selectedRows.reduce((sum, row) => sum + row.value_usd, 0);
        const qty = selectedRows.every((row) => row.qty_kg == null)
          ? null
          : selectedRows.reduce((sum, row) => sum + (row.qty_kg ?? 0), 0);
        const first = sorted.find((row) => row.value_usd > 0);
        const latestRow = [...sorted].reverse().find((row) => row.value_usd > 0);
        const cagr = first && latestRow && first.year < latestRow.year && first.value_usd > 0
          ? ((latestRow.value_usd / first.value_usd) ** (1 / (latestRow.year - first.year)) - 1) * 100
          : null;
        const total = totalByKey.get(`${selectedYear}|${selected.flow}|${selected.hs_code}`);
        const share = marketShare(value, total ?? null);
        return { ...selected, year: selectedYear, value_usd: value, qty_kg: qty, cagr, share };
      })
      .filter((row): row is ProductRow => row !== null)
      .sort((a, b) => b.value_usd - a.value_usd)
      .slice(0, 40);
  }, [partner.products, partner.iso3, flow, selectedYear, totalByKey]);

  useEffect(() => {
    if (product || !requestedHs || !requestedFlow) return;
    const match = productRows.find((row) => row.hs_code === requestedHs && row.flow === requestedFlow);
    if (match) setProduct(match);
  }, [product, productRows, requestedHs, requestedFlow]);

  const chart = partner.totals.map((t) => ({ year: t.year, exports: t.export_usd, imports: t.import_usd }));

  return (
    <>
      <div className="card">
        <div className="row between" style={{ gap: 10 }}>
          <div>
            <p className="overline">Bilateral market</p>
            <p className="card-title" style={{ marginBottom: 2 }}>{partner.name}</p>
            <p className="tiny dim">
              {partner.reporter_basis === 'primary' ? "Reported from the primary country's ingested data" : "No trade transaction recorded in the primary country's ingested data"}
              {partner.classification_level && <> · Detail: <strong>{partner.classification_level}</strong></>}
            </p>
          </div>
          <div className="row wrap" style={{ gap: 6 }}>
            {(['all', 'export', 'import'] as const).map((x) => (
              <button key={x} type="button" className={`chip ${flow === x ? 'active' : ''}`} onClick={() => setFlow(x)}>
                {x === 'all' ? 'All flows' : x === 'export' ? 'Exports' : 'Imports'}
              </button>
            ))}
          </div>
        </div>

        {partner.reporter_basis === 'none' ? (
          <div className="callout warn" style={{ marginTop: 14 }}>
            No trade transaction is recorded between {primaryName} and {partner.name} in the primary country's available five-year dataset.
          </div>
        ) : (
          <>
            <div className="row wrap" style={{ gap: 12, marginTop: 14 }}>
              <Metric label={`${latest} exports`} value={observed(latestTotals?.export_usd ?? null)} trend={growth(latestTotals?.export_usd, oldTotals?.export_usd)} />
              <Metric label={`${latest} imports`} value={observed(latestTotals?.import_usd ?? null)} trend={growth(latestTotals?.import_usd, oldTotals?.import_usd)} />
            </div>

            <div style={{ height: 230, marginTop: 16 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => money(Number(v))} width={62} />
                  <Tooltip formatter={(value) => value == null ? NO_TRANSACTION : money(Number(value))} />
                  {(flow === 'all' || flow === 'export') && <Line type="monotone" dataKey="exports" name="Exports" stroke="#0f9d58" strokeWidth={2} dot={false} connectNulls={false} />}
                  {(flow === 'all' || flow === 'import') && <Line type="monotone" dataKey="imports" name="Imports" stroke="#6d3bd4" strokeWidth={2} dot={false} connectNulls={false} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="tiny dim">A gap is a year with no stored transaction. It is not a recorded zero.</p>
          </>
        )}
      </div>

      <div className="card">
        <div className="row between" style={{ gap: 10 }}>
          <div>
            <p className="card-title">Products traded</p>
            <p className="tiny dim">
              {primaryName}'s recorded trade with {partner.name} in {selectedYear}. Market share uses {primaryName}'s total for that product, not the other selected countries.
            </p>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <select className="sandbox-select" value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))} aria-label={`Select product year for ${partner.name}`}>
              {partner.years.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
            <span className="badge on">{partner.classification_level ?? 'No detail'} · {productRows.length} products</span>
          </div>
        </div>
        {partner.reporter_basis === 'none' ? <Empty title="No trade transaction recorded" /> : productRows.length === 0 ? <Empty title="No product-level trade found" /> : (
          <div className="sandbox-table-wrap">
            <table className="sandbox-table">
              <thead><tr><th>Product</th><th>Flow</th><th>Year</th><th>Partner value</th><th>Market share</th><th>Trend</th></tr></thead>
              <tbody>
                {productRows.map((p) => (
                  <tr key={`${p.flow}-${p.hs_code}-${p.year}`} onClick={() => setProduct(p)} className="sandbox-row">
                    <td><strong>{p.product_name}</strong><span className="tiny dim">HS {p.hs_code}</span></td>
                    <td><span className={`badge ${p.flow === 'export' ? 'on' : 'moderate'}`}>{p.flow}</span></td>
                    <td>{p.year}</td>
                    <td>{money(p.value_usd)}</td>
                    <td>{shareText(p.share)}</td>
                    <td className={p.cagr == null ? 'dim' : p.cagr >= 0 ? 'up' : 'down'}>{p.cagr == null ? 'Not enough history' : `${p.cagr >= 0 ? '+' : ''}${p.cagr.toFixed(1)}%/yr`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {product && (
        <ProductSandboxModal
          product={product}
          years={partner.years}
          currentPartner={partner}
          primaryName={primaryName}
          primaryProductTotals={primaryProductTotals}
          onClose={() => setProduct(null)}
        />
      )}
    </>
  );
}

function Metric({ label, value, trend }: { label: string; value: string; trend: number | null }) {
  return <div className="stat" style={{ minWidth: 150 }}><span className="label">{label}</span><span className="value">{value}</span><span className="tiny dim">{trend == null ? 'Trend unavailable' : `${trend >= 0 ? '+' : ''}${trend.toFixed(1)}%/yr`}</span></div>;
}

function ProductSandboxModal({
  product,
  years,
  currentPartner,
  primaryName,
  primaryProductTotals,
  onClose,
}: {
  product: ProductRow;
  years: number[];
  currentPartner: TradeSandboxPartner;
  primaryName: string;
  primaryProductTotals: TradeSandboxProductTotal[];
  onClose: () => void;
}) {
  const partnerLine = product.flow === 'export'
    ? `${primaryName}'s exports to ${currentPartner.name}`
    : `${primaryName}'s imports from ${currentPartner.name}`;
  const totalLine = product.flow === 'export'
    ? `${primaryName}'s total exports of this product`
    : `${primaryName}'s total imports of this product`;
  const partnerStroke = product.flow === 'export' ? '#0f9d58' : '#6d3bd4';

  const data: ProductTrendPoint[] = years.map((year) => {
    const matches = currentPartner.products.filter(
      (row) => row.year === year && row.flow === product.flow && row.hs_code === product.hs_code && row.partner_iso3 === currentPartner.iso3,
    );
    const partnerValue = matches.length ? matches.reduce((sum, row) => sum + row.value_usd, 0) : null;
    const total = primaryProductTotals.find(
      (row) => row.year === year && row.flow === product.flow && row.hs_code === product.hs_code,
    );
    return { year, partner_usd: partnerValue, total_usd: total ? total.value_usd : null };
  });

  const current = data.find((point) => point.year === product.year);
  const currentShare = marketShare(current?.partner_usd ?? null, current?.total_usd ?? null);

  const tooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload?: ProductTrendPoint }> }) => {
    if (!active || !payload?.length) return null;
    const point = payload[0]?.payload;
    if (!point) return null;
    const share = marketShare(point.partner_usd, point.total_usd);
    return (
      <div className="card" style={{ margin: 0, padding: 10 }}>
        <strong>{point.year}</strong>
        <div className="tiny" style={{ marginTop: 4 }}>{partnerLine}: <strong>{observed(point.partner_usd)}</strong></div>
        <div className="tiny" style={{ marginTop: 4 }}>{totalLine}: <strong>{observed(point.total_usd)}</strong></div>
        <div className="tiny" style={{ marginTop: 4 }}>Market share: <strong>{shareText(share)}</strong></div>
      </div>
    );
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <p className="overline">Product detail</p>
            <h2 style={{ margin: 0 }}>{product.product_name}</h2>
            <p className="tiny dim">HS {product.hs_code} · {product.classification_level} · {product.flow}</p>
          </div>
          <button className="icon-btn" onClick={onClose} type="button">×</button>
        </div>

        <div className="row wrap" style={{ gap: 12, marginTop: 16 }}>
          <Metric label={`${product.year} · ${currentPartner.name}`} value={observed(current?.partner_usd ?? null)} trend={null} />
          <Metric label={`${product.year} · ${primaryName} total`} value={observed(current?.total_usd ?? null)} trend={null} />
          <Metric label="Market share" value={shareText(currentShare)} trend={null} />
          <Metric label="Quantity" value={product.qty_kg == null ? 'Not reported' : `${nf.format(product.qty_kg)} kg`} trend={null} />
        </div>

        <p className="tiny dim" style={{ marginTop: 14 }}>
          {partnerLine}. {totalLine}, across every stored partner. Market share is the partner value divided by that total.
        </p>

        <div style={{ height: 300, marginTop: 18 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
              <XAxis dataKey="year" />
              <YAxis tickFormatter={(v) => money(Number(v))} width={70} />
              <Tooltip content={tooltip} />
              <Legend />
              <Line type="monotone" dataKey="partner_usd" name={partnerLine} stroke={partnerStroke} strokeWidth={2} dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="total_usd" name={totalLine} stroke="#0b3d67" strokeWidth={2} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="sandbox-table-wrap">
          <table className="sandbox-table">
            <thead><tr><th>Year</th><th>{currentPartner.name}</th><th>{primaryName} total</th><th>Market share</th></tr></thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.year}>
                  <td>{point.year === product.year ? <strong>{point.year}</strong> : point.year}</td>
                  <td>{observed(point.partner_usd)}</td>
                  <td>{observed(point.total_usd)}</td>
                  <td>{shareText(marketShare(point.partner_usd, point.total_usd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="tiny dim">A blank year is no stored transaction, not a recorded zero. National HS8/HS10 codes are not automatically equivalent across countries.</p>
      </section>
    </div>
  );
}
