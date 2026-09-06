import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Skeletons, useToast } from '../components/ui';
import type { BusinessCard } from '../../shared/types';

export default function Me() {
  const { user, entitled, hasCard, subscriptions, feedUnread, loading, signOut, refresh } =
    useSession();
  const navigate = useNavigate();
  const t = useToast();
  const [card, setCard] = useState<BusinessCard | null>(null);
  const [closing, setClosing] = useState(false);
  const [closePassword, setClosePassword] = useState('');
  const [closingBusy, setClosingBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    api.network
      .myCard()
      .then((r) => setCard(r.card))
      .catch(() => undefined);
  }, [user, hasCard]);

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
              {entitled
                ? user.tier_expires_at
                  ? `Active until ${new Date(user.tier_expires_at).toLocaleDateString()}`
                  : 'Active'
                : 'Early signals, entry playbooks and a personal market feed.'}
            </div>
          </div>
          <Link className="btn sm primary" to="/upgrade">
            {entitled ? 'Manage' : 'See plans'}
          </Link>
        </div>
      </div>

      <div className="section-head">
        <h2>More</h2>
      </div>

      <Link className="list-item" to="/feed">
        <span className="grow">
          <span className="name">
            Your feed
            {feedUnread > 0 && (
              <span className="badge on" style={{ marginLeft: 8 }}>
                {feedUnread} new
              </span>
            )}
          </span>
          <span className="tiny dim">
            {subscriptions > 0
              ? `Following ${subscriptions} ${subscriptions === 1 ? 'thing' : 'things'}`
              : 'Follow a product or market to fill this'}
          </span>
        </span>
        <span className="dim">›</span>
      </Link>

      <Link className="list-item" to="/playbooks">
        <span className="grow">
          <span className="name">How to start</span>
          <span className="tiny dim">Entry playbooks with their sources</span>
        </span>
        <span className="dim">›</span>
      </Link>

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
          <span className="name">Owner portal</span>
          <span className="tiny dim">Registry, pipeline, users, sources and feedback</span>
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

      <div className="section-head">
        <h2>Your data</h2>
      </div>

      {card && (
        <button
          className="btn ghost block"
          type="button"
          onClick={async () => {
            if (!confirm('Remove your business card? Your phone, website and city go with it.')) {
              return;
            }
            try {
              await api.network.deleteCard();
              setCard(null);
              await refresh();
              t.ok('Card removed');
            } catch (e) {
              t.err((e as Error).message);
            }
          }}
        >
          Remove my business card
        </button>
      )}

      <button
        className="btn danger block"
        type="button"
        style={{ marginTop: 8 }}
        onClick={() => setClosing(true)}
      >
        Close my account
      </button>

      {closing && (
        <div className="card" style={{ marginTop: 10, borderColor: 'var(--down)' }}>
          <p className="card-title">Close your account</p>
          <p className="small muted" style={{ marginTop: 0 }}>
            This removes your account, your card, everything you follow, your feed and any private
            conversations you were part of. It cannot be undone.
          </p>
          <div className="field">
            <label htmlFor="close-password">Confirm your password</label>
            <input
              id="close-password"
              type="password"
              value={closePassword}
              onChange={(e) => setClosePassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn ghost sm"
              type="button"
              style={{ flex: 1 }}
              onClick={() => {
                setClosing(false);
                setClosePassword('');
              }}
            >
              Keep my account
            </button>
            <button
              className="btn danger sm"
              type="button"
              style={{ flex: 1 }}
              disabled={!closePassword || closingBusy}
              onClick={async () => {
                setClosingBusy(true);
                try {
                  await api.auth.close(closePassword);
                  await refresh();
                  navigate('/');
                } catch (e) {
                  t.err((e as Error).message);
                } finally {
                  setClosingBusy(false);
                }
              }}
            >
              {closingBusy ? 'Closing' : 'Close for good'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
