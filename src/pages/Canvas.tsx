import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';

type Canvas = Awaited<ReturnType<typeof api.canvas.get>>;
const TAG = { en: { typical: 'typical', data: 'from data', user: 'yours' }, de: { typical: 'üblich', data: 'aus Daten', user: 'von Ihnen' } } as const;

/** Start page: pick a product and country, build a canvas. Also lists saved canvases. */
export function CanvasStart() {
  const nav = useNavigate();
  const [list, setList] = useState<Awaited<ReturnType<typeof api.canvas.list>>['canvases']>([]);
  const [country, setCountry] = useState('');
  const [hs, setHs] = useState('');
  const [role, setRole] = useState<'supply' | 'procurement'>('supply');
  const [lang, setLang] = useState<'en' | 'de'>('en');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.canvas.list().then((r) => setList(r.canvases)).catch((e: Error) => setError(e.message)); }, []);
  async function create() {
    setBusy(true); setError('');
    try { const r = await api.canvas.create({ country, hs: hs.replace(/\D/g, ''), role, lang }); nav(`/canvas/${r.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not build the canvas'); } finally { setBusy(false); }
  }
  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>Build a Business Model Canvas for a product and country, pre-filled from Tereflow's trade data and standard trade practice, then edit every block.</p>
      <div style={{ display: 'grid', gap: 8, maxWidth: 420 }}>
        <input placeholder="Country (e.g. ghana)" value={country} onChange={(e) => setCountry(e.target.value)} />
        <input placeholder="6-digit HS code (e.g. 180100)" value={hs} onChange={(e) => setHs(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as 'supply' | 'procurement')}><option value="supply">I want to sell (supply)</option><option value="procurement">I want to buy (procurement)</option></select>
        <select value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'de')}><option value="en">English</option><option value="de">Deutsch</option></select>
        <div><button className="btn" disabled={busy || !country || hs.replace(/\D/g, '').length !== 6} onClick={() => void create()}>{busy ? 'Building...' : 'Build canvas'}</button></div>
        {error && <div className="small down">{error}</div>}
      </div>
      {list.length > 0 && <h3 style={{ marginTop: 24 }}>Your canvases</h3>}
      {list.map((c) => <Link className="list-item" key={c.id} to={`/canvas/${c.id}`}><span className="name">{c.title}</span><span className="tiny dim">{c.updated_at}</span></Link>)}
    </>
  );
}

export default function CanvasPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [cv, setCv] = useState<Canvas | null>(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api.canvas.get(id).then((c) => { setCv(c); setDirty(false); }).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <Empty title={error} hint="Premium members can build and keep canvases." />;
  if (!cv) return <Skeletons n={4} />;
  const tag = TAG[cv.lang];

  const edit = (key: string, i: number, text: string) => {
    setCv({ ...cv, blocks: { ...cv.blocks, [key]: cv.blocks[key].map((l, j) => (j === i ? { text, source: l.source === 'user' ? 'user' : l.source } : l)) } });
    setDirty(true);
  };
  const add = (key: string) => { setCv({ ...cv, blocks: { ...cv.blocks, [key]: [...cv.blocks[key], { text: '', source: 'user' }] } }); setDirty(true); };
  const drop = (key: string, i: number) => { setCv({ ...cv, blocks: { ...cv.blocks, [key]: cv.blocks[key].filter((_, j) => j !== i) } }); setDirty(true); };

  async function save() {
    try {
      const blocks = Object.fromEntries(Object.entries(cv!.blocks).map(([k, ls]) => [k, ls.filter((l) => l.text.trim())]));
      await api.canvas.save(id, blocks); setMsg('Saved'); load();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not save'); }
  }
  async function exportTxt() {
    const text = await api.canvas.exportText(id);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `canvas-${id}.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  async function switchLang(l: 'en' | 'de') {
    if (dirty && !window.confirm('Unsaved edits will be lost. Save first, or continue?')) return;
    await api.canvas.regenerate(id, l).catch((e: Error) => setMsg(e.message)); load();
  }

  const cell = (key: string) => {
    const d = cv.defs.find((x) => x.key === key)!;
    return (
      <div key={key} className="canvas-block" style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 10, breakInside: 'avoid' }}>
        <strong>{d.label}</strong>
        <div className="tiny dim" style={{ marginBottom: 6 }}>{d.help}</div>
        {cv.blocks[key].map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'flex-start' }}>
            <textarea value={l.text} rows={2} style={{ flex: 1, font: 'inherit' }} onChange={(e) => edit(key, i, e.target.value)} />
            <span className="tiny dim" style={{ minWidth: 56 }}>{tag[l.source]}</span>
            <button className="btn no-print" aria-label="Remove line" onClick={() => drop(key, i)}>x</button>
          </div>
        ))}
        <button className="btn no-print" onClick={() => add(key)}>+ line</button>
      </div>
    );
  };
  const g = (...k: string[]) => k.map(cell);

  return (
    <>
      <style>{'@media print { .no-print, nav, header, footer { display: none !important; } textarea { border: none; resize: none; } }'}</style>
      <h2 style={{ marginTop: 0 }}>{cv.title}</h2>
      <p className="tiny dim">{cv.lang === 'de' ? 'Zeilen mit „üblich“ sind gängige Praxis aus der Vorlage: bitte prüfen.' : 'Lines marked "typical" are standard practice from the template: please check them.'} Last saved {cv.updated_at}.</p>
      <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn" disabled={!dirty} onClick={() => void save()}>Save</button>
        <button className="btn" onClick={() => void switchLang(cv.lang === 'en' ? 'de' : 'en')}>{cv.lang === 'en' ? 'Deutsch' : 'English'}</button>
        <button className="btn" onClick={() => void exportTxt()}>Export text</button>
        <button className="btn" onClick={() => window.print()}>Print or save as PDF</button>
        <button className="btn" onClick={() => { if (window.confirm('Delete this canvas?')) void api.canvas.remove(id).then(() => nav('/canvas')); }}>Delete</button>
        {msg && <span className="small">{msg}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
        {g('key_partnerships', 'key_activities', 'key_resources', 'value_propositions', 'customer_relationships', 'channels', 'customer_segments', 'cost_structure', 'revenue_streams')}
      </div>
      <div className="no-print" style={{ marginTop: 16, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Link to={cv.next.guide}>Back to the Guide</Link>
        <Link to={cv.next.finance}>Finance in this country</Link>
      </div>
    </>
  );
}