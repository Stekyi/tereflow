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
  entitled: boolean;
  hasCard: boolean;
  cardPublished: boolean;
  unread: number;
  feedUnread: number;
  subscriptions: number;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [entitled, setEntitled] = useState(false);
  const [hasCard, setHasCard] = useState(false);
  const [cardPublished, setCardPublished] = useState(false);
  const [unread, setUnread] = useState(0);
  const [feedUnread, setFeedUnread] = useState(0);
  const [subscriptions, setSubscriptions] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.auth.me();
      setUser(r.user);
      setEntitled(Boolean(r.entitled));
      setHasCard(Boolean(r.has_card));
      setCardPublished(Boolean(r.card_published));
      setUnread(r.unread ?? 0);
      setFeedUnread(r.feed_unread ?? 0);
      setSubscriptions(r.subscriptions ?? 0);
    } catch {
      setUser(null);
      setEntitled(false);
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
    setEntitled(false);
    setHasCard(false);
    setCardPublished(false);
    setUnread(0);
    setFeedUnread(0);
    setSubscriptions(0);
  }, []);

  const value = useMemo(
    () => ({
      user,
      entitled,
      hasCard,
      cardPublished,
      unread,
      feedUnread,
      subscriptions,
      loading,
      refresh,
      signOut,
      setUser,
    }),
    [user, entitled, hasCard, cardPublished, unread, feedUnread, subscriptions, loading, refresh, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}
