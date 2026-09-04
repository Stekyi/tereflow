import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Skeletons, useToast } from '../components/ui';
import { fmtMoney, type Plan } from '../../shared/types';

const FEATURES = [
  {
    title: 'Early signals',
    body: 'Products with the momentum to reshape a market inside four years, while they are still outside the headline rankings. This is the window where entry is cheapest.',
  },
  {
    title: 'How to start',
    body: 'Entry playbooks per sector and market, sourced from the institutions that write the rules rather than generic advice.',
  },
  {
    title: 'Your watchlist feed',
    body: 'Follow a product or a market and get the push-and-pull read each week: who is selling it, who is buying it, and which way it is moving.',
  },
];

export default function Upgrade() {
  const { user, entitled, refresh, loading: sessionLoading } = useSession();
  const navigate = useNavigate();
  const t = useToast();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [provider, setProvider] = useState('stub');
  const [selected, setSelected] = useState('monthly');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.premium
      .plans()
      .then((r) => {
        setPlans(r.plans);
        setProvider(r.provider);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  async function start() {
    if (!user) return navigate('/join?next=/upgrade');
    setBusy(true);
    try {
      const r = await api.premium.checkout(selected);
      if (r.checkout_url) {
        window.location.href = r.checkout_url;
        return;
      }
      await refresh();
      t.ok('Premium is on');
      setTimeout(() => navigate('/feed'), 600);
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api.premium.cancel();
      await refresh();
      t.ok('Premium cancelled');
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading || sessionLoading) return <Skeletons n={4} />;

  return (
    <>
      {t.node}

      <div className="hero">
        <h2>{entitled ? 'You are on premium' : 'See the move before it is obvious'}</h2>
        <p>
          {entitled
            ? 'Early signals, the full playbook library and your weekly watchlist feed are unlocked.'
            : 'The trade data is free and always will be. Premium is the forward-looking read on top of it.'}
        </p>
      </div>

      <div className="card">
        {FEATURES.map((f) => (
          <div key={f.title} style={{ display: 'flex', gap: 11, marginBottom: 14 }}>
            <span className="badge premium" style={{ height: 'fit-content', marginTop: 2 }}>
              ★
            </span>
            <div>
              <div style={{ fontWeight: 650, fontSize: 14 }}>{f.title}</div>
              <div className="small dim">{f.body}</div>
            </div>
          </div>
        ))}
      </div>

      {entitled ? (
        <>
          {user?.tier_expires_at && (
            <p className="small dim" style={{ textAlign: 'center' }}>
              Renews {new Date(user.tier_expires_at).toLocaleDateString()}
            </p>
          )}
          <button className="btn danger block" onClick={cancel} disabled={busy}>
            {busy ? 'Working…' : 'Cancel premium'}
          </button>
          <Link className="btn ghost block" to="/playbooks" style={{ marginTop: 8 }}>
            Open the playbook library
          </Link>
        </>
      ) : (
        <>
          <div className="section-head">
            <h2>Choose a plan</h2>
          </div>

          {plans.map((p) => (
            <button
              key={p.id}
              className={`admin-row ${selected === p.id ? 'selected-plan' : ''}`}
              onClick={() => setSelected(p.id)}
              style={{
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                borderColor: selected === p.id ? 'var(--brand)' : undefined,
              }}
            >
              <span className={`dot ${selected === p.id ? 'ok' : 'unknown'}`} />
              <span>
                <span className="name">{p.label}</span>
                <span className="tiny dim">
                  {p.id === 'annual' ? 'Two months free versus monthly' : 'Cancel any time'}
                </span>
              </span>
              <strong style={{ fontSize: 15 }}>{fmtMoney(p.amount_minor, p.currency)}</strong>
            </button>
          ))}

          <button className="btn primary block" onClick={start} disabled={busy} style={{ marginTop: 12 }}>
            {busy ? 'Working…' : user ? 'Continue' : 'Join free, then upgrade'}
          </button>

          {provider === 'stub' && (
            <p className="tiny dim" style={{ marginTop: 10, textAlign: 'center' }}>
              No payment provider is configured on this deployment, so continuing grants premium
              directly. Set <code>STRIPE_SECRET_KEY</code> to take real payments.
            </p>
          )}
        </>
      )}
    </>
  );
}
