import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { Empty, Skeletons, useToast } from '../components/ui';
import { LISTING_KINDS, market, type Listing } from '../lib/api-social';
import { usePageTitle } from '../lib/pageTitle';

const kindLabel = (k: string) => LISTING_KINDS.find((x) => x.value === k)?.label ?? k;
const usd = (n: number | null) => (n == null ? '' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (s: string) => new Date(s.replace(' ', 'T') + 'Z');

function Countdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const ms = when(endsAt).getTime() - now;
  if (ms <= 0) return <span>Ended</span>;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return <span>{d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`} left</span>;
}

function Price({ l }: { l: Listing }) {
  if (l.mode === 'auction') {
    return <span>{l.current_bid != null ? `${usd(l.current_bid)} (${l.bid_count} bid${l.bid_count === 1 ? '' : 's'})` : `Starts at ${usd(l.start_price)}`}</span>;
  }
  return <span>{l.price_usd != null ? usd(l.price_usd) : 'Price on request'}</span>;
}

export default function Market() {
  usePageTitle('Market Square');
  const { user } = useSession();
  const [filters, setFilters] = useState({ q: '', kind: '', hs: '', country: '', mode: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ listings: Listing[]; total: number; limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null); setError(null);
    market.list({ ...applied, page }).then(setData).catch((e: Error) => setError(e.message));
  }, [applied, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <>
      <section className="mm-country-hero">
        <h1 className="mm-country-name">Market <em>Square</em></h1>
        <p className="mm-country-sub">Products for sale or wanted, supplier and buyer requests, export opportunities, partnerships and services, from verified members.</p>
        <div className="mm-cta-row">
          {user ? <Link className="mm-cta" to="/market/new">Post a listing</Link> : <Link className="mm-cta" to="/join?next=/market">Sign in to post</Link>}
          {user && <Link className="mm-cta ghost" to="/market/mine">My listings</Link>}
        </div>
      </section>

      <form className="card" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(filters); }}>
        <div className="sandbox-grid">
          <input className="sandbox-select" placeholder="Search listings" value={filters.q} maxLength={80} onChange={(e) => setFilters({ ...filters, q: e.target.value })} aria-label="Search" />
          <select className="sandbox-select" value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })} aria-label="Type">
            <option value="">All types</option>
            {LISTING_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <input className="sandbox-select" placeholder="HS code" value={filters.hs} inputMode="numeric" maxLength={10} onChange={(e) => setFilters({ ...filters, hs: e.target.value })} aria-label="HS code" />
          <input className="sandbox-select" placeholder="Country (ISO3)" value={filters.country} maxLength={3} onChange={(e) => setFilters({ ...filters, country: e.target.value.toUpperCase() })} aria-label="Country" />
          <select className="sandbox-select" value={filters.mode} onChange={(e) => setFilters({ ...filters, mode: e.target.value })} aria-label="Sale type">
            <option value="">Fixed and auctions</option><option value="fixed">Fixed price</option><option value="auction">Auctions</option>
          </select>
          <button className="btn primary" type="submit">Search</button>
        </div>
      </form>

      {error && <Empty title="Could not load listings" hint={error} />}
      {!data && !error && <Skeletons n={4} />}
      {data && data.listings.length === 0 && <Empty title="No listings match" hint="Try fewer filters." />}
      {data?.listings.map((l) => (
        <Link key={l.id} className="card list-item" to={`/market/${l.id}`} style={{ display: 'block' }}>
          <div className="row between">
            <strong>{l.title}</strong>
            <span className="badge on">{l.mode === 'auction' ? 'Auction' : kindLabel(l.kind)}</span>
          </div>
          <p className="tiny dim" style={{ margin: '4px 0' }}>
            {l.owner_name}{l.owner_company ? `, ${l.owner_company}` : ''}{l.country_iso3 ? ` · ${l.country_iso3}` : ''}{l.hs_code ? ` · HS ${l.hs_code}` : ''}
          </p>
          <div className="row between tiny"><Price l={l} />{l.mode === 'auction' && l.ends_at && <Countdown endsAt={l.ends_at} />}</div>
        </Link>
      ))}
      {data && pages > 1 && (
        <div className="row between" style={{ margin: '12px 0' }}>
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="tiny dim">Page {page} of {pages} · {data.total} listings</span>
          <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </>
  );
}

export function MarketNew() {
  usePageTitle('Post a listing');
  const { user, loading } = useSession();
  const navigate = useNavigate();
  const t = useToast();
  const [f, setF] = useState({ kind: 'for_sale', title: '', description: '', hs_code: '', country_iso3: '', price_usd: '', auction: false, start_price: '', min_increment: '', ends_at: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!loading && !user) navigate('/join?next=/market/new', { replace: true }); }, [loading, user, navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { kind: f.kind, title: f.title, description: f.description, hs_code: f.hs_code, country_iso3: f.country_iso3 };
      if (f.auction) {
        Object.assign(body, { mode: 'auction', start_price: f.start_price, min_increment: f.min_increment, ends_at: new Date(f.ends_at).toISOString() });
      } else if (f.price_usd) body.price_usd = f.price_usd;
      const r = await market.create(body);
      navigate(`/market/${r.id}`);
    } catch (err) { t.err((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="card" onSubmit={submit}>
      <p className="card-title">Post a listing</p>
      <select className="sandbox-select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, auction: e.target.value === 'for_sale' ? f.auction : false })}>
        {LISTING_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
      </select>
      <input className="sandbox-select" placeholder="Title" required minLength={3} maxLength={140} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <textarea className="sandbox-select" placeholder="Describe it" required maxLength={4000} rows={5} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <input className="sandbox-select" placeholder="HS code (optional)" inputMode="numeric" value={f.hs_code} onChange={(e) => setF({ ...f, hs_code: e.target.value })} />
      <input className="sandbox-select" placeholder="Country ISO3 (optional)" maxLength={3} value={f.country_iso3} onChange={(e) => setF({ ...f, country_iso3: e.target.value.toUpperCase() })} />
      {f.kind === 'for_sale' && (
        <label className="tiny"><input type="checkbox" checked={f.auction} onChange={(e) => setF({ ...f, auction: e.target.checked })} /> Sell by auction</label>
      )}
      {f.auction ? (
        <>
          <input className="sandbox-select" placeholder="Starting price (USD)" required inputMode="decimal" value={f.start_price} onChange={(e) => setF({ ...f, start_price: e.target.value })} />
          <input className="sandbox-select" placeholder="Minimum raise (USD)" required inputMode="decimal" value={f.min_increment} onChange={(e) => setF({ ...f, min_increment: e.target.value })} />
          <input className="sandbox-select" type="datetime-local" required value={f.ends_at} onChange={(e) => setF({ ...f, ends_at: e.target.value })} aria-label="Ends at" />
          <p className="tiny dim">Up to 30 days. Once someone bids, the auction cannot be edited, closed early or deleted.</p>
        </>
      ) : (
        <input className="sandbox-select" placeholder="Price in USD (optional)" inputMode="decimal" value={f.price_usd} onChange={(e) => setF({ ...f, price_usd: e.target.value })} />
      )}
      <button className="btn primary" disabled={busy}>{busy ? 'Posting' : 'Post listing'}</button>
      {t.node}
    </form>
  );
}

export function MarketMine() {
  usePageTitle('My listings');
  const { user, loading } = useSession();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Listing[] | null>(null);
  useEffect(() => { if (!loading && !user) navigate('/join?next=/market/mine', { replace: true }); }, [loading, user, navigate]);
  useEffect(() => { if (user) market.mine().then((r) => setRows(r.listings)).catch(() => setRows([])); }, [user]);
  if (!rows) return <Skeletons n={3} />;
  if (!rows.length) return <Empty title="You have no listings" hint="Post one from Market Square." />;
  return <>{rows.map((l) => (
    <Link key={l.id} className="card list-item" to={`/market/${l.id}`} style={{ display: 'block' }}>
      <div className="row between"><strong>{l.title}</strong><span className="badge">{l.status}</span></div>
      <p className="tiny dim" style={{ margin: '4px 0 0' }}><Price l={l} /></p>
    </Link>
  ))}</>;
}

export function MarketDetail() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const t = useToast();
  const [l, setL] = useState<Listing | null>(null);
  const [missing, setMissing] = useState(false);
  const [bids, setBids] = useState<{ amount: number; created_at: string; mine: boolean }[]>([]);
  const [enq, setEnq] = useState<{ id: string; body: string; from_name: string; conversation_id: string; created_at: string }[]>([]);
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  usePageTitle(l?.title ?? 'Listing');

  async function load() {
    try {
      const r = await market.get(id);
      setL(r.listing);
      if (r.listing.mode === 'auction') market.bids(id).then((b) => setBids(b.bids)).catch(() => undefined);
      if (r.listing.is_owner) market.enquiries(id).then((e) => setEnq(e.enquiries)).catch(() => undefined);
    } catch { setMissing(true); }
  }
  useEffect(() => { void load(); }, [id, user?.id]);
  useEffect(() => {
    if (l?.mode !== 'auction' || l.status !== 'open') return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [l?.mode, l?.status]);

  if (missing) return <Empty title="Listing not found" />;
  if (!l) return <Skeletons n={3} />;
  const signIn = `/join?next=${encodeURIComponent(`/market/${id}`)}`;
  const open = l.status === 'open';

  async function placeBid(e: React.FormEvent) {
    e.preventDefault();
    try { await market.bid(id, Number(amount)); t.ok('Bid placed'); setAmount(''); await load(); }
    catch (err) { t.err((err as Error).message); await load(); }
  }
  async function enquire(e: React.FormEvent) {
    e.preventDefault();
    try { const r = await market.enquire(id, text); navigate(`/messages/${r.conversation_id}`); }
    catch (err) { t.err((err as Error).message); }
  }

  return (
    <>
      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>{l.title}</h2>
          <span className="badge on">{l.status !== 'open' ? l.status : l.mode === 'auction' ? 'Auction' : kindLabel(l.kind)}</span>
        </div>
        <p className="tiny dim">{l.owner_name}{l.owner_company ? `, ${l.owner_company}` : ''}{l.country_iso3 ? ` · ${l.country_iso3}` : ''}{l.hs_code ? ` · HS ${l.hs_code}` : ''}</p>
        <p style={{ whiteSpace: 'pre-wrap' }}>{l.description}</p>
        <p><strong><Price l={l} /></strong>{l.mode === 'auction' && l.ends_at && <> · <Countdown endsAt={l.ends_at} /></>}</p>
        {l.mode === 'auction' && l.i_am_winning && open && <p className="up">You are the highest bidder.</p>}
        {l.mode === 'auction' && l.status === 'ended' && <p className="tiny dim">{l.bid_count ? `Sold at ${usd(l.current_bid)}.` : 'Ended with no bids.'}</p>}
      </div>

      {l.mode === 'auction' && open && !l.is_owner && (
        <div className="card">
          <p className="card-title">Place a bid</p>
          {user ? (
            <form onSubmit={placeBid} className="row" style={{ gap: 8 }}>
              <input className="sandbox-select" inputMode="decimal" required placeholder={`At least ${usd(l.current_bid == null ? l.start_price : (l.current_bid ?? 0) + (l.min_increment ?? 0))}`} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Bid amount in USD" />
              <button className="btn primary">Bid</button>
            </form>
          ) : <Link className="btn primary" to={signIn}>Sign in to bid</Link>}
        </div>
      )}

      {l.mode === 'auction' && bids.length > 0 && (
        <div className="card">
          <p className="card-title">Bids</p>
          {bids.map((b) => <div key={b.amount} className="row between tiny"><span>{usd(b.amount)}{b.mine ? ' (you)' : ''}</span><span className="dim">{when(b.created_at).toLocaleString()}</span></div>)}
        </div>
      )}

      {!l.is_owner && open && (
        <div className="card">
          <p className="card-title">Enquire</p>
          {user ? (
            <form onSubmit={enquire}>
              <textarea className="sandbox-select" required rows={4} maxLength={4000} placeholder="Ask the seller a question" value={text} onChange={(e) => setText(e.target.value)} />
              <button className="btn">Send enquiry</button>
            </form>
          ) : <Link className="btn" to={signIn}>Sign in to enquire</Link>}
        </div>
      )}

      {l.is_owner && (
        <div className="card">
          <p className="card-title">Enquiries</p>
          {enq.length === 0 && <p className="tiny dim">None yet.</p>}
          {enq.map((e) => <div key={e.id} style={{ margin: '8px 0' }}><strong className="tiny">{e.from_name}</strong> <Link className="tiny" to={`/messages/${e.conversation_id}`}>Reply</Link><p style={{ margin: '2px 0', whiteSpace: 'pre-wrap' }}>{e.body}</p></div>)}
          {open && l.bid_count === 0 && (
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={async () => { await market.close(id).catch((e: Error) => t.err(e.message)); await load(); }}>Close listing</button>
              <button className="btn" onClick={async () => { if (confirm('Delete this listing?')) { await market.remove(id).catch((e: Error) => t.err(e.message)); navigate('/market/mine'); } }}>Delete</button>
            </div>
          )}
        </div>
      )}
      {t.node}
    </>
  );
}
