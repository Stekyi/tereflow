import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Empty, FollowButton } from './ui';
import { isNewTrade, scoreBand, SCORE_BAND_LABEL, SCORE_BASIS } from '../../shared/opportunity';
import { hasLongerDescription } from '../../shared/product-name';
import {
  fmtPct,
  fmtUsd,
  type ProductCard,
  type ProductCountry,
  type ProductDetail,
} from '../../shared/types';

/**
 * One product as a tappable row. The card design lives here so Home, the
 * Marketplace and anywhere else that lists products all read the same way.
 * Tapping is the caller's job (it opens the modal), so this stays a plain
 * button and never navigates on its own.
 */
export function ProductCardRow({
  product,
  onOpen,
}: {
  product: ProductCard;
  onOpen: (hsCode: string) => void;
}) {
  const band = scoreBand(product.score);
  return (
    <button
      type="button"
      className="product-row"
      onClick={() => onOpen(product.hs_code)}
      aria-label={`${product.name}, ${product.country}, score ${product.score} of 100`}
    >
      <span className="flag">{product.iso3 ?? '??'}</span>
      <span className="grow">
        <span className="name">{product.name}</span>
        <span className="tiny dim product-row-meta">
          <span className={`badge ${product.flow === 'export' ? 'on' : 'moderate'}`}>
            {product.flow === 'export' ? 'Export' : 'Import'}
          </span>
          {product.country}
          {product.value_usd > 0 && <> {'\u00b7'} {fmtUsd(product.value_usd)}</>}
          {product.growth_pct != null &&
            (isNewTrade(product.growth_pct) ? (
              <> {'\u00b7'} <span className="up">Newly established</span></>
            ) : (
              <>
                {' \u00b7 '}
                <span className={product.growth_pct >= 0 ? 'up' : 'down'}>
                  {fmtPct(product.growth_pct, 0)}/yr
                </span>
              </>
            ))}
        </span>
        {product.best_market && (
          <span className="tiny dim">
            {product.best_market_product_specific
              ? `Biggest market for this product: ${product.best_market}`
              : `Biggest ${product.flow === 'export' ? 'buyer' : 'supplier'} overall: ${product.best_market}`}
          </span>
        )}
      </span>
      <span className="product-row-score" style={{ flex: 'none', textAlign: 'right' }}>
        <span className={`badge ${band}`} title={SCORE_BASIS}>
          {product.score}/100
        </span>
        <span className="tiny dim" style={{ display: 'block', marginTop: 4 }}>
          {SCORE_BAND_LABEL[band]}
        </span>
      </span>
    </button>
  );
}

/** Ranked country list inside the modal, using the shared bar-row pattern. */
function RankList({ title, rows }: { title: string; rows: ProductCountry[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.value_usd), 1);
  return (
    <div className="card">
      <p className="card-title">{title}</p>
      {rows.map((r) => (
        <div className="bar-row" key={r.slug}>
          <div className="bar-fill" style={{ width: `${Math.max(3, (r.value_usd / max) * 100)}%` }} />
          <div className="bar-content">
            <span className="rank-badge">{r.rank}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 620, fontSize: 14 }}>{r.name}</span>
              <span className="tiny dim">
                {r.year > 0 ? r.year : 'Year not reported'}
                {r.growth_pct != null &&
                  (isNewTrade(r.growth_pct) ? (
                    <> {'\u00b7'} <span className="up">newly established</span></>
                  ) : (
                    <>
                      {' \u00b7 '}
                      <span className={r.growth_pct >= 0 ? 'up' : 'down'}>
                        {fmtPct(r.growth_pct, 0)}/yr
                      </span>
                    </>
                  ))}
              </span>
            </span>
            <span className="num" style={{ fontWeight: 700, fontSize: 14 }}>
              {fmtUsd(r.value_usd)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The global product view. Opens on any product tap and never navigates to a
 * country page. Related products swap the modal in place, with a small history
 * so the reader can step back.
 */
export default function ProductModal({
  hsCode,
  onClose,
}: {
  hsCode: string;
  onClose: () => void;
}) {
  const { user } = useSession();
  const [hs, setHs] = useState(hsCode);
  const [history, setHistory] = useState<string[]>([]);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .product(hs)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [hs]);

  // Load what the reader already follows so the star reads correctly on open.
  useEffect(() => {
    if (!user) return;
    let live = true;
    api.premium
      .subscriptions()
      .then((r) => {
        if (!live) return;
        setFollowing(
          new Set(r.subscriptions.filter((s) => s.kind === 'hs_code').map((s) => s.value)),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [user]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Lock the page behind the modal so only the modal scrolls.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const openRelated = useCallback(
    (nextHs: string) => {
      setHistory((h) => [...h, hs]);
      setHs(nextHs);
    },
    [hs],
  );

  const goBack = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setHs(prev);
      return h.slice(0, -1);
    });
  }, []);

  const toggleFollow = useCallback(
    async (next: boolean, _kind: string, value: string, label: string) => {
      // Optimistic; the star should feel instant.
      setFollowing((set) => {
        const copy = new Set(set);
        if (next) copy.add(value);
        else copy.delete(value);
        return copy;
      });
      try {
        if (next) {
          await api.premium.follow({ kind: 'hs_code', value, label });
        } else {
          const subs = await api.premium.subscriptions();
          const match = subs.subscriptions.find((s) => s.kind === 'hs_code' && s.value === value);
          if (match) await api.premium.unfollow(match.id);
        }
      } catch {
        // Roll back if the write failed so the star stays honest.
        setFollowing((set) => {
          const copy = new Set(set);
          if (next) copy.delete(value);
          else copy.add(value);
          return copy;
        });
      }
    },
    [],
  );

  const nonProductPartners = detail?.partners.some((p) => !p.product_specific) ?? false;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-product-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="row between" style={{ gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <p className="overline" style={{ margin: 0 }}>
              {history.length > 0 ? (
                <button
                  type="button"
                  onClick={goBack}
                  style={{
                    padding: 0,
                    border: 'none',
                    background: 'none',
                    color: 'var(--brand)',
                    cursor: 'pointer',
                    font: 'inherit',
                    letterSpacing: 'inherit',
                    textTransform: 'inherit',
                  }}
                >
                  {'\u2039'} Back
                </button>
              ) : (
                'Product worldwide'
              )}
            </p>
            <h2 id="global-product-title" style={{ margin: '3px 0 0', fontSize: 24 }}>
              {detail?.name ?? 'Loading product'}
            </h2>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            {'\u00d7'}
          </button>
        </div>

        {loading ? (
          <div className="skeleton" style={{ height: 120, marginTop: 18 }} />
        ) : error || !detail ? (
          <Empty title="Could not load this product" hint={error ?? undefined} />
        ) : (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0 4px' }}>
              <span className={`badge ${detail.category === 'traditional' ? 'watch' : 'on'}`}>
                {detail.category === 'traditional' ? 'Traditional' : 'Non-traditional'}
              </span>
              <span className="partner-chip">HS {detail.hs_code}</span>
              {user && (
                <FollowButton
                  kind="hs_code"
                  value={detail.hs_code}
                  label={detail.name}
                  following={following.has(detail.hs_code)}
                  onChange={toggleFollow}
                />
              )}
            </div>

            <p className="small muted" style={{ margin: '4px 0 0' }}>
              {detail.sector}
              {detail.chapter_label && detail.chapter_label !== detail.name && (
                <> {'\u00b7'} {detail.chapter_label}</>
              )}
            </p>

            {detail.name_full &&
              detail.name_full !== detail.name &&
              hasLongerDescription(detail.name_full) && (
                <p className="tiny dim" style={{ margin: '6px 0 0' }}>
                  Full description: {detail.name_full}
                </p>
              )}

            <div className="product-summary">
              <div>
                <span className="tiny dim">Sold by countries on record</span>
                <strong>{fmtUsd(detail.total_export_usd)}</strong>
              </div>
              <div>
                <span className="tiny dim">Bought by countries on record</span>
                <strong>{fmtUsd(detail.total_import_usd)}</strong>
              </div>
            </div>

            <p className="tiny dim" style={{ margin: '10px 0 0' }}>
              These totals cover the countries Tereflow has analysed, not every country in the
              world, so they read lower than global trade in this product.
              {detail.partial_coverage &&
                ' Some of those countries have not reported a comparable earlier year, so their growth is left blank rather than estimated.'}
            </p>

            <div style={{ height: 14 }} />
            <RankList title="Sells the most" rows={detail.exporters} />
            <RankList title="Buys the most" rows={detail.importers} />

            {detail.partners.length > 0 && (
              <div className="card">
                <p className="card-title">Trading partners</p>
                <div className="opportunity-partners" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
                  {detail.partners.slice(0, 12).map((p) => (
                    <span className="partner-chip" key={p.iso3 ?? p.name}>
                      {p.name}
                    </span>
                  ))}
                </div>
                {nonProductPartners && (
                  <p className="tiny dim" style={{ margin: '10px 0 0' }}>
                    Partner detail here is reported per trade flow, not per product, on the current
                    sources. These are the countries this trade moves between overall, not proof
                    that this specific product goes to each one.
                  </p>
                )}
              </div>
            )}

            {detail.related.length > 0 && (
              <div className="card">
                <p className="card-title">Related products</p>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {detail.related.map((r) => (
                    <button
                      type="button"
                      key={r.hs_code}
                      className="chip"
                      onClick={() => openRelated(r.hs_code)}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Link className="btn primary block" to={`/marketplace?hs=${encodeURIComponent(detail.hs_code)}`}>
              Find partners for this product
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
