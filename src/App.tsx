import { Suspense, lazy } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Skeletons } from './components/ui';

const Home = lazy(() => import('./pages/Home'));
const Explore = lazy(() => import('./pages/Explore'));
const Country = lazy(() => import('./pages/Country'));
const Registry = lazy(() => import('./pages/Registry'));
const Admin = lazy(() => import('./pages/Admin'));
const AdminForm = lazy(() => import('./pages/AdminForm'));

const TITLES: Record<string, string> = {
  '/': 'TradeAtlas',
  '/explore': 'Explore markets',
  '/registry': 'Data registry',
  '/admin': 'Admin',
  '/admin/new': 'New record',
};

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const isSub = location.pathname.split('/').filter(Boolean).length > 1;
  const title = TITLES[location.pathname] ?? 'TradeAtlas';

  return (
    <div className="app">
      <header className="topbar">
        {isSub ? (
          <button className="back-btn" onClick={() => navigate(-1)} aria-label="Go back">
            ‹ Back
          </button>
        ) : (
          <span className="brand-mark">
            <span className="brand-dot" />
          </span>
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
        <Tab to="/" label="Home" d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
        <Tab
          to="/explore"
          label="Explore"
          d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 0v20M2 12h20M12 2c3 3 3 17 0 20M12 2C9 5 9 19 12 22"
          stroke
        />
        <Tab
          to="/registry"
          label="Sources"
          d="M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z"
        />
        <Tab
          to="/admin"
          label="Admin"
          d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.4-3a8.4 8.4 0 0 0-.13-1.4l2-1.5-2-3.4-2.3 1a8.5 8.5 0 0 0-2.4-1.4L15.2 2h-4l-.37 2.3a8.5 8.5 0 0 0-2.4 1.4l-2.3-1-2 3.4 2 1.5a8.4 8.4 0 0 0 0 2.8l-2 1.5 2 3.4 2.3-1a8.5 8.5 0 0 0 2.4 1.4l.37 2.3h4l.37-2.3a8.5 8.5 0 0 0 2.4-1.4l2.3 1 2-3.4-2-1.5c.09-.46.13-.93.13-1.4z"
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
}: {
  to: string;
  label: string;
  d: string;
  stroke?: boolean;
}) {
  return (
    <NavLink to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
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
      {label}
    </NavLink>
  );
}
