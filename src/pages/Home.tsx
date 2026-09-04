import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type HomeStats } from '../lib/api';
import { useSession } from '../lib/auth';
import { Empty, Skeletons } from '../components/ui';
import type { Entity } from '../../shared/types';

export default function Home() {
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [active, setActive] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);
  const { user, entitled, feedUnread } = useSession();

  useEffect(() => {
    Promise.all([api.stats(), api.entities({ kind: 'country' })])
      .then(([s, e]) => {
        setStats(s);
        setActive(e.entities);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="hero">
        <h2>Know a market before you enter it</h2>
        <p>
          What a country sells, what it buys, who it trades with, and where the next opening is.
          Rebuilt from official statistics every Friday.
        </p>
      </div>

      {user && feedUnread > 0 && (
        <Link className="card tight" to="/feed" style={{ display: 'block', borderColor: 'var(--brand)' }}>
          <div className="row between">
            <span>
              <span style={{ fontWeight: 650, fontSize: 15 }}>
                {feedUnread} new in your feed
              </span>
              <span className="tiny dim" style={{ display: 'block' }}>
                From the markets and products you follow
              </span>
            </span>
            <span className="dim">›</span>
          </div>
        </Link>
      )}

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
            <h2>{entitled ? 'Premium' : 'Go further'}</h2>
            {user && (
              <Link className="hint" to="/feed">
                Your feed ›
              </Link>
            )}
          </div>

          <div className="card">
            <PremiumLine
              title="Early signals"
              body="Products with the momentum to reshape a market inside four years, before they reach anybody's top ten."
            />
            <PremiumLine
              title="How to start"
              body="Entry playbooks per sector and market, sourced from the institutions that write the rules."
            />
            <PremiumLine
              title="Your watchlist"
              body="Follow a product or a market and get the push-and-pull read in your feed each week."
            />
            {entitled ? (
              <Link className="btn primary block" to="/feed" style={{ marginTop: 12 }}>
                Open your feed
              </Link>
            ) : (
              <Link className="btn primary block" to="/upgrade" style={{ marginTop: 12 }}>
                {user ? 'See premium' : 'Join free, then upgrade'}
              </Link>
            )}
            <Link className="btn ghost block" to="/playbooks" style={{ marginTop: 8 }}>
              Browse the playbook library
            </Link>
          </div>

          <div className="section-head">
            <h2>Find people to trade with</h2>
            <Link className="hint" to="/network">
              Open network ›
            </Link>
          </div>
          <Link className="list-item" to="/network">
            <span className="grow">
              <span className="name">Buyers, sellers, suppliers and distributors</span>
              <span className="tiny dim">
                Search by product or market, then message them directly
              </span>
            </span>
            <span className="dim">›</span>
          </Link>

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
