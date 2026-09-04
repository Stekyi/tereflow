import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Empty, Skeletons, useToast } from '../components/ui';
import type { FeedItem, Subscription } from '../../shared/types';

export default function Feed() {
  const { user, entitled, loading: sessionLoading, refresh } = useSession();
  const navigate = useNavigate();
  const t = useToast();

  const [items, setItems] = useState<FeedItem[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [lockedCount, setLockedCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionLoading && !user) navigate('/join?next=/feed', { replace: true });
  }, [sessionLoading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    Promise.all([api.premium.feed(), api.premium.subscriptions()])
      .then(([f, s]) => {
        setItems(f.items);
        setLockedCount(f.locked_count);
        setSubs(s.subscriptions);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [user, entitled]);

  async function markAllRead() {
    await api.premium.markRead().catch(() => undefined);
    setItems((prev) => prev.map((i) => ({ ...i, read_at: new Date().toISOString() })));
    await refresh();
  }

  async function unfollow(id: string) {
    try {
      await api.premium.unfollow(id);
      setSubs((prev) => prev.filter((s) => s.id !== id));
      await refresh();
      t.ok('Unfollowed');
    } catch (e) {
      t.err((e as Error).message);
    }
  }

  if (sessionLoading || loading) return <Skeletons n={5} />;

  return (
    <>
      {t.node}

      <div className="section-head" style={{ marginTop: 0 }}>
        <h2>Following</h2>
        <Link className="hint" to="/explore">
          Add more ›
        </Link>
      </div>

      {subs.length === 0 ? (
        <div className="card">
          <p className="small dim" style={{ marginTop: 0 }}>
            Follow a product, sector or market and its weekly analysis lands here. Open any market
            and tap Follow on a product.
          </p>
          <Link className="btn primary block" to="/explore">
            Browse markets
          </Link>
        </div>
      ) : (
        <div className="row wrap" style={{ gap: 7, marginBottom: 6 }}>
          {subs.map((s) => (
            <button key={s.id} className="chip active" onClick={() => unfollow(s.id)} title="Unfollow">
              {s.label ?? s.value} ✕
            </button>
          ))}
        </div>
      )}

      <div className="section-head">
        <h2>Your feed</h2>
        {items.some((i) => !i.read_at) && (
          <button className="hint" onClick={markAllRead} style={{ background: 'none', border: 0, color: 'var(--brand)', cursor: 'pointer' }}>
            Mark all read
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <Empty
          title="Nothing in the feed yet"
          hint={
            subs.length === 0
              ? 'Follow something first.'
              : 'The next analysis run is Friday 21:00 GMT. Items appear after it finishes.'
          }
        />
      ) : (
        items.map((i) => <FeedCard key={i.id} item={i} />)
      )}

      {!entitled && lockedCount > 0 && (
        <div className="locked" style={{ marginTop: 12 }}>
          <div style={{ fontSize: 24 }}>🔒</div>
          <h3>
            {lockedCount} forward-looking {lockedCount === 1 ? 'read' : 'reads'} held back
          </h3>
          <p>
            You can see what moved. Premium tells you where it is going and how much time you have
            to get in.
          </p>
          <Link className="btn gold block" to="/upgrade">
            See premium
          </Link>
        </div>
      )}
    </>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const when = new Date(item.created_at.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  });

  return (
    <div className="card" style={item.read_at ? { opacity: 0.72 } : undefined}>
      <div className="row between" style={{ marginBottom: 6, gap: 10 }}>
        <strong style={{ fontSize: 15, lineHeight: 1.3 }}>{item.title}</strong>
        {!item.read_at && <span className="dot ok" style={{ marginTop: 6 }} />}
      </div>

      {item.locked ? (
        <div
          style={{
            border: '1px dashed var(--gold)',
            borderRadius: 10,
            padding: '10px 12px',
            marginTop: 8,
          }}
        >
          <span className="badge premium">Premium</span>
          <p className="small dim" style={{ margin: '7px 0 0' }}>
            The read on where this goes next is part of premium.
          </p>
          <Link className="btn sm" to="/upgrade" style={{ marginTop: 9 }}>
            Unlock
          </Link>
        </div>
      ) : (
        item.body && (
          <p className="small muted" style={{ margin: 0 }}>
            {item.body}
          </p>
        )
      )}

      <div className="row between" style={{ marginTop: 10 }}>
        <span className="tiny dim">
          {item.kind === 'signal'
            ? 'Early signal'
            : item.kind === 'market_balance'
              ? 'Push and pull'
              : 'Market trend'}{' '}
          · {when}
        </span>
        {item.entity_slug && (
          <Link className="tiny" to={`/country/${item.entity_slug}`}>
            {item.entity_name} ›
          </Link>
        )}
      </div>
    </div>
  );
}
