import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getTier, setTier, type HomeStats } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';
import type { Entity } from '../../shared/types';

export default function Home() {
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [active, setActive] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const [tier, setTierState] = useState(getTier());

  useEffect(() => {
    Promise.all([api.stats(), api.entities({ kind: 'country' })])
      .then(([s, e]) => {
        setStats(s);
        setActive(e.entities);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  function toggleTier() {
    const next = tier === 'premium' ? 'free' : 'premium';
    setTier(next);
    setTierState(next);
  }

  return (
    <>
      <div className="hero">
        <h2>Know a market before you enter it</h2>
        <p>
          What a country sells, what it buys, who it trades with, and where the next opening is.
          Rebuilt from official statistics every Friday.
        </p>
      </div>

      {loading ? (
        <Skeletons n={3} />
      ) : (
        <>
          <div className="grid two" style={{ marginBottom: 12 }}>
            <StatTile label="Countries live" value={String(stats?.countries_active ?? 0)} />
            <StatTile label="In registry" value={String(stats?.countries ?? 0)} />
            <StatTile
              label="Data bodies"
              value={String((stats?.orgs ?? 0) + (stats?.regional ?? 0))}
            />
            <StatTile label="Source links" value={String(stats?.sources ?? 0)} />
          </div>

          <div className="section-head">
            <h2>Live markets</h2>
            <Link className="hint" to="/explore">
              See all ›
            </Link>
          </div>

          {active.length === 0 ? (
            <Empty
              title="No country is activated yet"
              hint="Open Admin, tick a country, then run the analysis to populate its dashboard."
            />
          ) : (
            active.slice(0, 8).map((e) => (
              <Link className="list-item" key={e.slug} to={`/country/${e.slug}`}>
                <span className="flag">{e.iso3 ?? '??'}</span>
                <span className="grow">
                  <span className="name">{e.name}</span>
                  <span className="tiny dim">
                    {e.continent}
                    {e.last_ingest_at ? ` · updated ${e.last_ingest_at.slice(0, 10)}` : ' · awaiting first run'}
                  </span>
                </span>
                <span className="dim">›</span>
              </Link>
            ))
          )}

          <div className="section-head">
            <h2>Premium</h2>
          </div>

          <div className="card">
            <PremiumLine
              title="Early signals"
              body="Products with the momentum to reshape a market inside four years, before they reach anybody's top ten."
            />
            <PremiumLine
              title="How to start"
              body="Entry playbooks per sector and market, drawn from trade experts rather than generic advice."
            />
            <PremiumLine
              title="Your watchlist"
              body="Follow a product or a market and get the push-and-pull analysis in your feed each week."
            />
            <button className="btn block" onClick={toggleTier} style={{ marginTop: 12 }}>
              {tier === 'premium' ? 'Premium preview on — turn off' : 'Preview premium features'}
            </button>
            <p className="tiny dim" style={{ margin: '8px 0 0', textAlign: 'center' }}>
              Preview toggle stands in for billing until Phase 3.
            </p>
          </div>

          {stats?.last_run && (
            <p className="tiny dim" style={{ textAlign: 'center', marginTop: 18 }}>
              Last analysis run {new Date(stats.last_run + 'Z').toLocaleString()} · next run Friday
              21:00 GMT
            </p>
          )}
        </>
      )}
    </>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function PremiumLine({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 11, marginBottom: 13 }}>
      <span className="badge premium" style={{ height: 'fit-content', marginTop: 2 }}>
        ★
      </span>
      <div>
        <div style={{ fontWeight: 650, fontSize: 14 }}>{title}</div>
        <div className="small dim">{body}</div>
      </div>
    </div>
  );
}
