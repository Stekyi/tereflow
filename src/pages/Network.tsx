import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Chips, Empty, Skeletons } from '../components/ui';
import {
  INTENTS,
  INTENT_LABEL,
  SECTOR_OPTIONS,
  type BusinessCard,
  type Intent,
} from '../../shared/types';

export default function Network() {
  const { user, hasCard } = useSession();
  const [params] = useSearchParams();
  const [cards, setCards] = useState<BusinessCard[]>([]);
  // Seeded from the query string so "find partners for this product" in the
  // product modal lands here with the search already filled in, rather than on
  // a second product list that duplicates the home page.
  const [q, setQ] = useState(params.get('q') ?? '');
  const [intent, setIntent] = useState<Intent | ''>('');
  const [sector, setSector] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handle = setTimeout(() => {
      setLoading(true);
      api.network
        .discover({ q, intent: intent || undefined, sector: sector || undefined })
        .then((r) => setCards(r.cards))
        .catch(() => setCards([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [q, intent, sector]);

  const intentOptions = useMemo(
    () => [
      { value: '' as Intent | '', label: 'Everyone' },
      ...INTENTS.map((i) => ({ value: i as Intent | '', label: INTENT_LABEL[i] })),
    ],
    [],
  );

  const sectorOptions = useMemo(
    () => [{ value: '', label: 'All sectors' }, ...SECTOR_OPTIONS.map((s) => ({ value: s, label: s }))],
    [],
  );

  return (
    <>
      {!user && (
        <div className="card" style={{ borderColor: 'var(--brand)' }}>
          <div style={{ fontWeight: 650, marginBottom: 4 }}>Browsing as a guest</div>
          <p className="small dim" style={{ margin: '0 0 12px' }}>
            Create a free account to add your own card and message people directly.
          </p>
          <Link className="btn primary block" to="/join?next=/network">
            Join free
          </Link>
        </div>
      )}

      {user && !hasCard && (
        <div className="card" style={{ borderColor: 'var(--gold)' }}>
          <div style={{ fontWeight: 650, marginBottom: 4 }}>You have no card yet</div>
          <p className="small dim" style={{ margin: '0 0 12px' }}>
            People cannot find you until you say what you trade.
          </p>
          <Link className="btn primary block" to="/me/card">
            Create my business card
          </Link>
        </div>
      )}

      <input
        type="search"
        placeholder="Search a product, sector or name — try moringa"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <Chips options={intentOptions} value={intent} onChange={setIntent} />
      <div style={{ height: 8 }} />
      <Chips options={sectorOptions} value={sector} onChange={setSector} />
      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={5} />
      ) : cards.length === 0 ? (
        <Empty
          title="Nobody matches yet"
          hint="The network is new. Try a broader search, or be the first in your sector."
        />
      ) : (
        cards.map((c) => <CardRow key={c.id} card={c} />)
      )}
    </>
  );
}

export function CardRow({ card }: { card: BusinessCard }) {
  return (
    <Link className="list-item" to={`/network/${card.id}`}>
      <span className="flag">{card.country_iso3}</span>
      <span className="grow">
        <span className="name">{card.display_name}</span>
        <span className="tiny dim">
          {card.headline || card.company || card.sectors.slice(0, 2).join(', ') || 'Trader'}
        </span>
        <span className="tiny" style={{ marginTop: 3 }}>
          {card.intents.slice(0, 3).map((i) => (
            <span key={i} className="badge moderate" style={{ marginRight: 4 }}>
              {INTENT_LABEL[i]}
            </span>
          ))}
          {card.rating_count > 0 && (
            <span className="badge on">
              ★ {card.rating_avg.toFixed(1)} ({card.rating_count})
            </span>
          )}
        </span>
      </span>
      <span className="dim">›</span>
    </Link>
  );
}
