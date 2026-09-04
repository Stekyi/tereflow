import { Suspense, lazy } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Skeletons } from './components/ui';
import { useSession } from './lib/auth';

const Home = lazy(() => import('./pages/Home'));
const Explore = lazy(() => import('./pages/Explore'));
const Country = lazy(() => import('./pages/Country'));
const Registry = lazy(() => import('./pages/Registry'));
const Admin = lazy(() => import('./pages/Admin'));
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

const TITLES: Record<string, string> = {
  '/': 'Tereflow',
  '/explore': 'Explore markets',
  '/network': 'Network',
  '/messages': 'Messages',
  '/me': 'Me',
  '/me/card': 'My business card',
  '/feed': 'Your feed',
  '/playbooks': 'How to start',
  '/upgrade': 'Premium',
  '/registry': 'Data registry',
  '/admin': 'Admin',
  '/admin/new': 'New record',
  '/join': 'Join Tereflow',
};

const ROOTS = new Set(['/', '/explore', '/network', '/messages', '/me']);

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { unread, feedUnread } = useSession();

  const isRoot = ROOTS.has(location.pathname);
  const title = TITLES[location.pathname] ?? 'Tereflow';

  return (
    <div className="app">
      <header className="topbar">
        {isRoot ? (
          <span className="brand-mark">
            <span className="brand-dot" />
          </span>
        ) : (
          <button className="back-btn" onClick={() => navigate(-1)} aria-label="Go back">
            ‹ Back
          </button>
        )}
        <h1>{title}</h1>
      </header>

      <main>
        <Suspense fallback={<Skeletons n={5} />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/explore" element={<Explore />} />
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

            <Route path="/admin" element={<Admin />} />
            <Route path="/admin/new" element={<AdminForm />} />
            <Route path="/admin/edit/:slug" element={<AdminForm />} />

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

      <nav className="tabbar">
        <Tab
          to="/"
          label="Home"
          d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"
          badge={feedUnread}
        />
        <Tab
          to="/explore"
          label="Markets"
          d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 0v20M2 12h20M12 2c3 3 3 17 0 20M12 2C9 5 9 19 12 22"
          stroke
        />
        <Tab
          to="/network"
          label="Network"
          d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm0 1.5c-3 0-6 1.5-6 3.5v2h12v-2c0-2-3-3.5-6-3.5zm8-1c-.9 0-1.8.14-2.6.4 1.6.9 2.6 2.2 2.6 3.6v2h6v-2c0-2-3-4-6-4z"
        />
        <Tab
          to="/messages"
          label="Messages"
          d="M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l5-4h6a2 2 0 0 0 2-2z"
          badge={unread}
        />
        <Tab
          to="/me"
          label="Me"
          d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5z"
        />
      </nav>
    </div>
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
