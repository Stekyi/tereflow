import { Suspense, lazy, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Skeletons } from './components/ui';
import { Logo } from './components/Brand';
import FeedbackButton from './components/FeedbackButton';
import { useSession } from './lib/auth';
import { PageTitleContext } from './lib/pageTitle';

const Home = lazy(() => import('./pages/Home'));
const Countries = lazy(() => import('./pages/Countries'));
const Opportunities = lazy(() => import('./pages/Opportunities'));
const Country = lazy(() => import('./pages/Country'));
const Registry = lazy(() => import('./pages/Registry'));
const Portal = lazy(() => import('./pages/Portal'));
const AdminForm = lazy(() => import('./pages/AdminForm'));
const Auth = lazy(() => import('./pages/Auth'));
const Network = lazy(() => import('./pages/Network'));
const CardDetail = lazy(() => import('./pages/CardDetail'));
const CardEditor = lazy(() => import('./pages/CardEditor'));
const Messages = lazy(() => import('./pages/Messages'));
const Thread = lazy(() => import('./pages/Thread'));
const Me = lazy(() => import('./pages/Me'));
const Feed = lazy(() => import('./pages/Feed'));
const Playbooks = lazy(() => import('./pages/Playbooks'));
const PlaybookDetail = lazy(() => import('./pages/PlaybookDetail'));
const Upgrade = lazy(() => import('./pages/Upgrade'));
const TradeSandbox = lazy(() => import('./pages/TradeSandbox'));
const TradeNews = lazy(() => import('./pages/TradeNews'));

const TITLES: Record<string, string> = {
  '/': 'Tereflow',
  '/countries': 'Countries',
  '/network': 'Network',
  '/messages': 'Messages',
  '/me': 'Me',
  '/me/card': 'My business card',
  '/feed': 'Your feed',
  '/playbooks': 'How to start',
  '/upgrade': 'Premium',
  '/sandbox': 'Trade sandbox',
  '/news': 'Trade news',
  '/registry': 'Data registry',
  '/admin': 'Owner portal',
  '/admin/new': 'New record',
  '/join': 'Join Tereflow',
};

/**
 * One list drives the desktop top bar. Mobile keeps the five-tab bottom bar below, because five is
 * what fits under a thumb; the rest is reached from the Me tab.
 */
const NAV: { to: string; label: string; d: string; stroke?: boolean; badge?: 'feed' | 'messages' }[] = [
  { to: '/', label: 'Products', d: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z' },
  { to: '/countries', label: 'Countries', d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 0v20M2 12h20M12 2c3 3 3 17 0 20M12 2C9 5 9 19 12 22', stroke: true },
  { to: '/news', label: 'Trade news', d: 'M5 4h12a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2zM9 8h6M9 12h6M9 16h3', stroke: true },
  { to: '/sandbox', label: 'Sandbox', d: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5', stroke: true },
  { to: '/opportunities', label: 'Opportunities', d: 'M4 19 10 13l4 3 6-8', stroke: true },
  { to: '/network', label: 'Network', d: 'M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm0 1.5c-3 0-6 1.5-6 3.5v2h12v-2c0-2-3-3.5-6-3.5zm8-1c-.9 0-1.8.14-2.6.4 1.6.9 2.6 2.2 2.6 3.6v2h6v-2c0-2-3-4-6-4z' },
  { to: '/feed', label: 'Feed', d: 'M5 5h14v14H5zM8 9h8M8 12h8M8 15h5', stroke: true, badge: 'feed' },
  { to: '/messages', label: 'Messages', d: 'M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l5-4h6a2 2 0 0 0 2-2z', badge: 'messages' },
  { to: '/me', label: 'Me', d: 'M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5z' },
];

const ROOTS = new Set(['/', '/countries', '/news', '/network', '/me']);

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { unread, feedUnread } = useSession();
  // Detail pages report their real entity name through this state. A route
  // change unmounts the old page, whose cleanup clears the name, so a page that
  // reports nothing falls back to its static label below.
  const [pageTitle, setPageTitle] = useState<string | null>(null);

  const isRoot = ROOTS.has(location.pathname);
  const title = pageTitle ?? TITLES[location.pathname] ?? 'Tereflow';

  return (
    <PageTitleContext.Provider value={setPageTitle}>
    <div className="app">
      <header className="topnav">
        <div className="topnav-inner">
          <NavLink to="/" className="topnav-brand" aria-label="Tereflow home">
            <span className="brand-dot">
              <Logo size={22} />
            </span>
            <span className="topnav-word">Tereflow</span>
          </NavLink>
          <nav className="topnav-links" aria-label="Main navigation">
            {NAV.map((n) => (
              <TopLink
                key={n.to}
                {...n}
                badge={n.badge === 'feed' ? feedUnread : n.badge === 'messages' ? unread : 0}
              />
            ))}
          </nav>
        </div>
      </header>

      <header className="topbar">
        {isRoot ? (
          <span className="brand-mark">
            <span className="brand-dot">
              <Logo size={22} />
            </span>
          </span>
        ) : (
          <button className="back-btn" onClick={() => navigate(-1)} aria-label="Go back">
            ‹ Back
          </button>
        )}
        <h1>{title}</h1>
        {/* Messages came off the tab bar to get it down to four. It still needs
            to be one tap away, so it lives here with its unread count. */}
        <NavLink className="topbar-action" to="/messages" aria-label="Messages">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l5-4h6a2 2 0 0 0 2-2z" />
          </svg>
          {unread > 0 && <span className="tab-badge">{unread > 9 ? '9+' : unread}</span>}
        </NavLink>
      </header>

      <main>
        <Suspense fallback={<Skeletons n={5} />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/countries" element={<Countries />} />
          <Route path="/opportunities" element={<Opportunities />} />
            <Route path="/country/:slug" element={<Country />} />
            <Route path="/registry" element={<Registry />} />

            <Route path="/join" element={<Auth />} />
            <Route path="/network" element={<Network />} />
            <Route path="/network/:id" element={<CardDetail />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/messages/:id" element={<Thread />} />
            <Route path="/me" element={<Me />} />
            <Route path="/me/card" element={<CardEditor />} />
            <Route path="/feed" element={<Feed />} />
            <Route path="/playbooks" element={<Playbooks />} />
            <Route path="/playbooks/:slug" element={<PlaybookDetail />} />
            <Route path="/upgrade" element={<Upgrade />} />
            <Route path="/sandbox" element={<TradeSandbox />} />
            <Route path="/news" element={<TradeNews />} />

            <Route path="/admin" element={<Portal />} />
            <Route path="/admin/new" element={<AdminForm />} />
            <Route path="/admin/edit/:slug" element={<AdminForm />} />
            <Route path="/admin/classifications" element={<Navigate to="/admin" replace />} />
            <Route path="/admin/feedback" element={<Navigate to="/admin" replace />} />

            <Route
              path="*"
              element={
                <div className="empty">
                  <p>That page does not exist.</p>
                  <NavLink className="btn primary" to="/">
                    Go home
                  </NavLink>
                </div>
              }
            />
          </Routes>
        </Suspense>
      </main>

      {/* Primary navigation: mobile app-style bottom bar. Desktop uses the top navigation bar above. */}
      <nav className="tabbar" aria-label="Primary navigation">
        <Tab
          to="/"
          label="Products"
          d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"
          badge={feedUnread}
        />
        <Tab
          to="/countries"
          label="Countries"
          d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 0v20M2 12h20M12 2c3 3 3 17 0 20M12 2C9 5 9 19 12 22"
          stroke
        />
        <Tab
          to="/news"
          label="News"
          d="M5 4h12a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2zM9 8h6M9 12h6M9 16h3"
          stroke
        />
        <Tab
          to="/network"
          label="Network"
          d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm0 1.5c-3 0-6 1.5-6 3.5v2h12v-2c0-2-3-3.5-6-3.5zm8-1c-.9 0-1.8.14-2.6.4 1.6.9 2.6 2.2 2.6 3.6v2h6v-2c0-2-3-4-6-4z"
        />
        <Tab
          to="/me"
          label="Me"
          d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5z"
        />
      </nav>

      <FeedbackButton />
    </div>
    </PageTitleContext.Provider>
  );
}

function TopLink({
  to,
  label,
  d,
  stroke,
  badge,
}: {
  to: string;
  label: string;
  d: string;
  stroke?: boolean;
  badge?: number;
}) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'topnav-link active' : 'topnav-link')}>
      <span className="tab-icon">
        <svg
          viewBox="0 0 24 24"
          fill={stroke ? 'none' : 'currentColor'}
          stroke={stroke ? 'currentColor' : 'none'}
          strokeWidth={stroke ? 1.7 : 0}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d={d} />
        </svg>
        {badge != null && badge > 0 && <span className="tab-badge">{badge > 9 ? '9+' : badge}</span>}
      </span>
      <span className="topnav-label">{label}</span>
    </NavLink>
  );
}

function Tab({
  to,
  label,
  d,
  stroke,
  badge,
}: {
  to: string;
  label: string;
  d: string;
  stroke?: boolean;
  badge?: number;
}) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span className="tab-icon">
        <svg
          viewBox="0 0 24 24"
          fill={stroke ? 'none' : 'currentColor'}
          stroke={stroke ? 'currentColor' : 'none'}
          strokeWidth={stroke ? 1.7 : 0}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d={d} />
        </svg>
        {badge != null && badge > 0 && <span className="tab-badge">{badge > 9 ? '9+' : badge}</span>}
      </span>
      {label}
    </NavLink>
  );
}
