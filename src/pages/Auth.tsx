import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { useToast } from '../components/ui';

export default function Auth() {
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'register' | 'login'>(
    params.get('mode') === 'login' ? 'login' : 'register',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const { setUser, refresh } = useSession();
  const navigate = useNavigate();
  const t = useToast();

  const next = params.get('next') || '/network';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r =
        mode === 'register'
          ? await api.auth.register({ email, password, full_name: name })
          : await api.auth.login({ email, password });
      setUser(r.user);
      await refresh();
      navigate(mode === 'register' ? '/me/card' : next, { replace: true });
    } catch (err) {
      t.err((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {t.node}

      <div className="hero">
        <span className="overline">{mode === 'register' ? 'Free to join' : 'Members'}</span>
        <h2>{mode === 'register' ? 'Join the network' : 'Welcome back'}</h2>
        <p>
          {mode === 'register'
            ? 'Free. Three fields. Then tell people what you are looking to trade.'
            : 'Sign in to reach buyers, sellers and partners.'}
        </p>
      </div>

      <form className="card" onSubmit={submit}>
        {mode === 'register' && (
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ama Boateng"
              required
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="pw">Password</label>
          <input
            id="pw"
            type="password"
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            required
          />
        </div>

        <button className="btn primary block" type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'register' ? 'Create free account' : 'Sign in'}
        </button>
      </form>

      <button
        className="btn ghost block"
        onClick={() => setMode(mode === 'register' ? 'login' : 'register')}
      >
        {mode === 'register' ? 'I already have an account' : 'Create a free account instead'}
      </button>
    </>
  );
}
