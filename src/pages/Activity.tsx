import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { Empty, Skeletons, useToast } from '../components/ui';
import { notices, SAVED_STATUSES, social, type Notice, type Post, type SavedOpportunity } from '../lib/api-social';
import { usePageTitle } from '../lib/pageTitle';

function useGate(next: string) {
  const { user, loading } = useSession();
  const navigate = useNavigate();
  useEffect(() => { if (!loading && !user) navigate(`/join?next=${encodeURIComponent(next)}`, { replace: true }); }, [loading, user, navigate, next]);
  return user;
}

const stamp = (s: string) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString();

export function Activity() {
  usePageTitle('Activity');
  const user = useGate('/activity');
  const t = useToast();
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [hs, setHs] = useState('');

  async function load(before?: string) {
    try {
      const r = await social.feed(before);
      setPosts((p) => (before && p ? [...p, ...r.posts] : r.posts));
      setMore(r.next_before);
    } catch (e) { t.err((e as Error).message); setPosts((p) => p ?? []); }
  }
  useEffect(() => { if (user) void load(); }, [user]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try { await social.post(draft, hs || undefined); setDraft(''); setHs(''); await load(); }
    catch (err) { t.err((err as Error).message); }
  }

  if (!user) return <Skeletons n={3} />;
  return (
    <>
      <form className="card" onSubmit={submit}>
        <p className="card-title">Post to your network</p>
        <textarea className="sandbox-select" required rows={3} maxLength={2000} placeholder="What are you buying, selling or looking for?" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <input className="sandbox-select" placeholder="HS code (optional)" inputMode="numeric" value={hs} onChange={(e) => setHs(e.target.value)} />
        <button className="btn primary">Post</button>
        <p className="tiny dim">You need a published business card to post. <Link to="/me/card">Edit your card</Link></p>
      </form>
      {!posts && <Skeletons n={3} />}
      {posts && posts.length === 0 && <Empty title="Nothing here yet" hint="Follow people from the Network page and their posts appear here." />}
      {posts?.map((p) => (
        <div key={p.id} className="card">
          <div className="row between"><strong>{p.display_name}{p.company ? `, ${p.company}` : ''}</strong><span className="tiny dim">{stamp(p.created_at)}</span></div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{p.body}</p>
          {p.hs_code && <span className="badge">HS {p.hs_code}</span>}
          {p.author_id === user.id && <button className="link-btn" onClick={async () => { await social.deletePost(p.id).catch(() => undefined); await load(); }}> Delete</button>}
        </div>
      ))}
      {more && <button className="btn" onClick={() => void load(more)}>Older posts</button>}
      {t.node}
    </>
  );
}

function SavedCard({ s, onChange }: { s: SavedOpportunity; onChange: () => void }) {
  const t = useToast();
  const [notes, setNotes] = useState(s.notes ?? '');
  const [links, setLinks] = useState(s.research_links.join('\n'));
  const sandbox = `/sandbox?primary=${encodeURIComponent(s.country_slug)}${s.partner_iso3 ? `&partner=${s.partner_iso3}` : ''}${s.hs_code ? `&hs=${s.hs_code}` : ''}${s.flow ? `&flow=${s.flow}` : ''}`;
  async function save() {
    try {
      await social.update(s.id, { notes, research_links: links.split('\n').map((x) => x.trim()).filter(Boolean) });
      t.ok('Saved'); onChange();
    } catch (err) { t.err((err as Error).message); }
  }
  return (
    <div className="card">
      <div className="row between">
        <strong>{s.title}</strong>
        <select value={s.status} aria-label="Status" onChange={async (e) => { await social.update(s.id, { status: e.target.value }).catch((er: Error) => t.err(er.message)); onChange(); }}>
          {SAVED_STATUSES.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </div>
      <p className="tiny"><Link to={sandbox}>Open in Sandbox</Link> · <Link to={`/country/${s.country_slug}`}>Country</Link></p>
      <textarea className="sandbox-select" rows={3} maxLength={5000} placeholder="Private notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <textarea className="sandbox-select" rows={2} placeholder="Research links, one per line" value={links} onChange={(e) => setLinks(e.target.value)} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => void save()}>Save notes</button>
        <button className="btn" onClick={async () => { await social.unsave(s.id).catch(() => undefined); onChange(); }}>Remove</button>
      </div>
      {t.node}
    </div>
  );
}

export function Saved() {
  usePageTitle('Saved opportunities');
  const user = useGate('/saved');
  const [rows, setRows] = useState<SavedOpportunity[] | null>(null);
  const load = () => social.saved().then((r) => setRows(r.saved)).catch(() => setRows([]));
  useEffect(() => { if (user) void load(); }, [user]);
  if (!rows) return <Skeletons n={3} />;
  if (!rows.length) return <Empty title="Nothing saved yet" hint="Use Save on a partner row in a country view. Your notes and links are private to you." />;
  return <>{rows.map((s) => <SavedCard key={s.id} s={s} onChange={() => void load()} />)}</>;
}

export function Notifications() {
  usePageTitle('Notifications');
  const user = useGate('/notifications');
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [rows, setRows] = useState<Notice[] | null>(null);
  const load = () => notices.list().then((r) => setRows(r.notifications)).catch(() => setRows([]));
  useEffect(() => { if (user) void load(); }, [user]);

  const target = (n: Notice) => (n.kind === 'message' || n.kind === 'enquiry' ? `/messages/${n.ref_id}` : `/market/${n.ref_id}`);
  if (!rows) return <Skeletons n={3} />;
  return (
    <>
      <div className="row between" style={{ margin: '8px 0' }}>
        <h2 style={{ margin: 0 }}>Notifications</h2>
        <button className="btn" onClick={async () => { await notices.read(); await load(); await refresh(); }}>Mark all read</button>
      </div>
      {rows.length === 0 && <Empty title="No notifications" />}
      {rows.map((n) => (
        <div key={n.id} className="card list-item" style={{ cursor: 'pointer', opacity: n.read_at ? 0.6 : 1 }}
          onClick={async () => { await notices.read([n.id]).catch(() => undefined); navigate(target(n)); }}>
          <p style={{ margin: 0 }}>{n.body}</p>
          <p className="tiny dim" style={{ margin: '4px 0 0' }}>{stamp(n.created_at)}</p>
        </div>
      ))}
    </>
  );
}
