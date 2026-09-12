/**
 * Ghana opportunities, from Ghana's own statistics.
 *
 * Everything on this page is precomputed and stored. Opening it does not call
 * StatBank.
 *
 * The design rule here is that a number never appears without what it rests on.
 * Score sits next to confidence, because a high score on two years of chapter
 * data is a real thing and hiding the second number would make the first one a
 * lie. Limitations are shown rather than tucked behind a tooltip, and when the
 * last ingest failed the page says so instead of quietly serving old figures as
 * though they were current.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, type OpportunityFeed, type TradeOpportunity } from '../lib/api';
import { usePageTitle } from '../lib/pageTitle';

const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

const SIGNAL_LABEL: Record<string, string> = {
  import_substitution: 'Import substitution',
  supplier_diversification: 'Supplier diversification',
  export_growth: 'Export growth',
};

const TREND_LABEL: Record<string, string> = {
  growing: 'Growing',
  declining: 'Declining',
  stable: 'Stable',
  volatile: 'Volatile',
  insufficient_data: 'Not enough data',
};

export default function Opportunities() {
  const [feed, setFeed] = useState<OpportunityFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  usePageTitle('Ghana opportunities');

  useEffect(() => {
    setLoading(true);
    api
      .ghanaOpportunities({ flow: 'import', limit: 60, includeExcluded: showExcluded })
      .then((r) => {
        setFeed(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [showExcluded]);

  const shown = useMemo(() => feed?.opportunities ?? [], [feed]);

  if (loading && !feed) return <div className="card">Loading Ghana import opportunities...</div>;
  if (error) {
    return (
      <div className="card">
        <p className="card-title">Could not load opportunities</p>
        <p className="dim">{error}</p>
      </div>
    );
  }
  if (!feed) return null;

  return (
    <>
      <div className="card">
        <p className="card-title">Ghana import opportunities</p>
        <p className="dim">
          What Ghana buys from abroad, ranked by how much a locally made alternative might matter.
          Every figure comes from {feed.source} at {feed.classification} chapter level.
        </p>
        <p className="tiny dim">
          The opportunity score here weighs market size, growth, import dependency, stability and
          supplier concentration on Ghana's own statistics. It is a different measure from the
          momentum score shown against products elsewhere, which reads how fast a line is moving in
          world trade data. The two are not on the same scale and should not be compared.
        </p>

        {feed.serving_stale && (
          <div className="callout warn" style={{ marginTop: 10 }}>
            The most recent ingestion failed. These are the last figures that loaded cleanly
            {feed.last_successful_run ? `, from ${formatDate(feed.last_successful_run.completed_at)}` : ''}.
            Nothing has been substituted from another source.
          </div>
        )}

        <div className="row wrap" style={{ gap: 14, marginTop: 12 }}>
          <Fact label="Products ranked" value={String(feed.count)} />
          <Fact
            label="Last updated"
            value={feed.last_successful_run ? formatDate(feed.last_successful_run.completed_at) : 'never'}
          />
          <Fact label="Classification" value={feed.classification} />
        </div>

        <label className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={showExcluded}
            onChange={(e) => setShowExcluded(e.target.checked)}
          />
          <span className="tiny dim">
            Show traditional commodities, which are kept out of the ranking by default
          </span>
        </label>
      </div>

      {shown.length === 0 && (
        <div className="card">
          <p className="card-title">Nothing to show yet</p>
          <p className="dim">
            No opportunities have been computed. Run the ingestion job to load Ghana&apos;s trade
            statistics.
          </p>
        </div>
      )}

      {shown.map((o) => (
        <OpportunityCard
          key={`${o.product_code}-${o.trade_flow}`}
          o={o}
          open={open === o.product_code}
          onToggle={() => setOpen(open === o.product_code ? null : o.product_code)}
        />
      ))}
    </>
  );
}

function OpportunityCard({
  o,
  open,
  onToggle,
}: {
  o: TradeOpportunity;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="card" style={o.is_excluded ? { opacity: 0.62 } : undefined}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <p className="card-title" style={{ marginBottom: 2 }}>
            {o.product_name}
          </p>
          <span className="tiny dim">
            HS{o.product_code} {'\u00b7'} {SIGNAL_LABEL[o.signal_type] ?? o.signal_type}
          </span>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
            {o.opportunity_score.toFixed(1)}
          </div>
          {/* Confidence sits directly under the score on purpose. The two answer
              different questions and showing one without the other is how a
              number built on two years of data starts to look certain. */}
          <span className={`badge ${o.confidence === 'high' ? 'on' : o.confidence === 'low' ? 'off' : 'watch'}`}>
            {CONFIDENCE_LABEL[o.confidence] ?? o.confidence}
          </span>
        </div>
      </div>

      {o.is_excluded && (
        <p className="tiny dim" style={{ marginTop: 8 }}>
          Kept out of the ranking: {o.excluded_reason}
        </p>
      )}

      <div className="row wrap" style={{ gap: 14, marginTop: 10 }}>
        <Fact label={`${o.latest_year} imports`} value={usd(o.latest_import_value)} />
        <Fact label="Trend" value={TREND_LABEL[o.trend] ?? o.trend} />
        <Fact
          label="3 year growth"
          value={o.three_year_cagr == null ? 'Not available' : `${signed(o.three_year_cagr)}% a year`}
        />
        <Fact label="Top supplier" value={o.top_partner ?? 'Not reported'} />
      </div>

      <p style={{ marginTop: 10 }}>{o.explanation}</p>

      <button type="button" className="link-button tiny" onClick={onToggle} style={{ marginTop: 8 }}>
        {open ? 'Hide the evidence' : 'Show the evidence and the limits'}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <Section title="What this is built on">
            <ul className="tiny">
              {o.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Section>

          {o.partner_shares.length > 0 && (
            <Section title="Where it comes from">
              <ul className="tiny">
                {o.partner_shares.slice(0, 6).map((p) => (
                  <li key={p.partner}>
                    {p.partner}: {p.share_pct.toFixed(1)}% ({usd(p.value_usd)})
                  </li>
                ))}
              </ul>
              {o.supplier_concentration_hhi != null && (
                <p className="tiny dim">
                  Supplier concentration (HHI): {o.supplier_concentration_hhi.toFixed(2)} across{' '}
                  {o.partner_count} reporting partners.
                </p>
              )}
            </Section>
          )}

          <Section title="How confident we are, and why">
            <ul className="tiny">
              {o.confidence_reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Section>

          {/* Shown, not hidden. These are the reasons somebody should not act on
              this without doing their own work, and burying them would be the
              dishonest half of presenting a score at all. */}
          <Section title="What this data cannot tell you">
            <ul className="tiny">
              {o.data_limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </Section>

          <p className="tiny dim" style={{ marginTop: 8 }}>
            Source: {o.source}. Classification {o.classification}.
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <p className="tiny" style={{ fontWeight: 650, marginBottom: 4 }}>
        {title}
      </p>
      {children}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tiny dim">{label}</div>
      <div className="num" style={{ fontWeight: 620 }}>
        {value}
      </div>
    </div>
  );
}

function usd(v: number | null): string {
  if (v == null || !isFinite(v)) return 'Not reported';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
