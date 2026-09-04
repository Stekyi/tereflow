import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import type { SessionUser } from '../../shared/types';

interface SessionState {
  user: SessionUser | null;
  hasCard: boolean;
  cardPublished: boolean;
  unread: number;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [hasCard, setHasCard] = useState(false);
  const [cardPublished, setCardPublished] = useState(false);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.auth.me();
      setUser(r.user);
      setHasCard(Boolean(r.has_card));
      setCardPublished(Boolean(r.card_published));
      setUnread(r.unread ?? 0);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the unread badge honest without a socket. Cheap enough at this size.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => void refresh(), 45_000);
    return () => clearInterval(t);
  }, [user, refresh]);

  const signOut = useCallback(async () => {
    await api.auth.logout().catch(() => undefined);
    setUser(null);
    setHasCard(false);
    setCardPublished(false);
    setUnread(0);
  }, []);

  const value = useMemo(
    () => ({ user, hasCard, cardPublished, unread, loading, refresh, signOut, setUser }),
    [user, hasCard, cardPublished, unread, loading, refresh, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
