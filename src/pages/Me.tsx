import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Skeletons, Toggle, useToast } from '../components/ui';
import type { BusinessCard } from '../../shared/types';

export default function Me() {
  const { user, hasCard, loading, refresh, signOut } = useSession();
  const navigate = useNavigate();
  const t = useToast();
  const [card, setCard] = useState<BusinessCard | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    api.network
      .myCard()
      .then((r) => setCard(r.card))
      .catch(() => undefined);
  }, [user, hasCard]);

  async function toggleTier(next: boolean) {
    setBusy(true);
    try {
      await api.auth.setTier(next ? 'premium' : 'free');
      await refresh();
      t.ok(next ? 'Premium preview on' : 'Back to free');
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Skeletons n={4} />;

  if (!user) {
    return (
      <>
        <div className="hero">
          <h2>Your account</h2>
          <p>Join free to add a business card, message people and follow markets.</p>
        </div>
        <Link className="btn primary block" to="/join">
          Create free account
        </Link>
        <Link className="btn ghost block" to="/join?mode=login" style={{ marginTop: 8 }}>
          Sign in
        </Link>
        <div className="section-head">
          <h2>Browse without an account</h2>
        </div>
        <Link className="list-item" to="/registry">
          <span className="grow">
            <span className="name">Data sources</span>
            <span className="tiny dim">Every official publication behind the numbers</span>
          </span>
          <span className="dim">›</span>
        </Link>
      </>
    );
  }

  return (
    <>
      {t.node}

      <div className="row" style={{ gap: 12, marginBottom: 16 }}>
        <span className="flag" style={{ width: 44, height: 44, borderRadius: 999, fontSize: 15 }}>
          {user.full_name.slice(0, 1).toUpperCase()}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 720, letterSpacing: '-0.02em' }}>
            {user.full_name}
          </div>
          <div className="tiny dim">{user.email}</div>
        </div>
      </div>

      <Link className="list-item" to="/me/card">
        <span className="grow">
          <span className="name">{card ? 'My business card' : 'Create my business card'}</span>
          <span className="tiny dim">
            {card
              ? card.is_published
                ? `Visible · ${card.intents.length} intent${card.intents.length === 1 ? '' : 's'}`
                : 'Hidden — not visible in search'
              : 'Tell people what you trade'}
          </span>
        </span>
        <span className="dim">›</span>
      </Link>

      {card?.is_published === 1 && (
        <Link className="list-item" to={`/network/${card.id}`}>
          <span className="grow">
            <span className="name">See my card as others see it</span>
            <span className="tiny dim">
              {card.rating_count > 0
                ? `★ ${card.rating_avg.toFixed(1)} from ${card.rating_count}`
                : 'No ratings yet'}
            </span>
          </span>
          <span className="dim">›</span>
        </Link>
      )}

      <div className="card">
        <div className="row between">
          <div>
            <div style={{ fontWeight: 650 }}>
              Premium <span className="badge premium">★</span>
            </div>
            <div className="tiny dim" style={{ maxWidth: 380 }}>
              Early signals, entry playbooks and a personal market feed. Preview toggle stands in for
              billing until Phase 3.
            </div>
          </div>
          <Toggle
            checked={user.tier === 'premium'}
            onChange={toggleTier}
            disabled={busy}
          />
        </div>
      </div>

      <div className="section-head">
        <h2>More</h2>
      </div>

      <Link className="list-item" to="/registry">
        <span className="grow">
          <span className="name">Data sources</span>
          <span className="tiny dim">Every official publication behind the numbers</span>
        </span>
        <span className="dim">›</span>
      </Link>

      {/* Admin authenticates with its own shared token, not the user role, so
          the entry point is always visible and the token screen does the gating. */}
      <Link className="list-item" to="/admin">
        <span className="grow">
          <span className="name">Admin</span>
          <span className="tiny dim">Registry, activation and analysis runs</span>
        </span>
        <span className="dim">›</span>
      </Link>

      <button
        className="btn ghost block"
        style={{ marginTop: 12 }}
        onClick={async () => {
          await signOut();
          navigate('/');
        }}
      >
        Sign out
      </button>
    </>
  );
}
