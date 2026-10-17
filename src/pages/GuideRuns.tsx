import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { GuideResult } from '../../shared/guide';

type Run = {
  inputs: { country: string; product: string; hs: string; role: string; budget_usd: number | null };
  lens: { note: string } | null;
  sources: string[];
} & GuideResult;
type Item = { id: string; title: string; country_slug: string; hs_code: string; role: string; budget_usd: number | null; created_at: string; risk: string | null };

const usd = (n: number | null | undefined) => (n == null ? 'unavailable' : `$${Math.round(n).toLocaleString('en-US')}`);
const box = { border: '1px solid var(--line, #cfd4dc)', borderRadius: 8, padding: '12px 14px', margin: '10px 0' } as const;
const day = (s: string) => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const PRINT_CSS = '@media print{.no-print,.topnav,.topbar,.tabbar,.mm-footer,header,footer,nav{display:none!important}main{max-width:none!important;padding:0!important}body{font-size:11px}h1{font-size:18px}h2{font-size:13px;margin:8px 0 2px}ul{margin:2px 0;padding-left:16px}li{margin:0}.keep{break-inside:avoid}@page{size:A4;margin:12mm}}';

async function get<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    return r.ok ? { ok: true, data: (await r.json()) as T } : { ok: false, status: r.status };
  } catch { return { ok: false, status: 0 }; }
}

function Gate({ status }: { status: number }) {
  return <p>{status === 402 || status === 401 ? <>Saved runs are for premium members. <Link to="/upgrade">See premium</Link></> : 'Could not load this right now. Try again in a moment.'}</p>;
}

/** What a reader would put in front of a partner or a lender: the verdict first, then the reasons, kept to one page. */
function Summary({ run, savedAt }: { run: Run; savedAt?: string }) {
  const buyers = run.chain.find((c) => c.from_data && /buyer|market|supplier|source/i.test(c.stage));
  return (
    <article>
      <h1 style={{ marginBottom: 2 }}>{run.inputs.product} in {run.inputs.country}</h1>
      <p className="tiny dim">
        {run.inputs.role === 'supply' ? 'Supply' : 'Procurement'} view, HS {run.inputs.hs}
        {run.inputs.budget_usd ? `, budget ${usd(run.inputs.budget_usd)}` : ''}
        {savedAt ? `, saved ${day(savedAt)}` : ''}. Built from UN Comtrade data by fixed rules, with no language model.
      </p>
      {run.lens && <p className="tiny" style={box}>{run.lens.note}</p>}
      <section className="keep" style={box}>
        <h2 style={{ marginTop: 0 }}>Risk and return</h2>
        <p><strong>Risk: {run.risk.level}.</strong> {run.risk.reasons.join(' ')}</p>
        {run.estimate.available
          ? <p><strong>Indicative return on {usd(run.inputs.budget_usd)}: {usd(run.estimate.low_usd)} to {usd(run.estimate.high_usd)}.</strong> {run.estimate.caveats.join(' ')}</p>
          : <p><strong>Return estimate: unavailable.</strong> {run.estimate.caveats.join(' ')}</p>}
      </section>
      {buyers && <p><strong>{buyers.stage}:</strong> {buyers.actors.join(', ')}</p>}
      <h2>Problems found</h2>
      {run.problems.length === 0 && <p>No problem could be formed from the data held.</p>}
      {run.problems.map((p) => (
        <section key={p.key} className="keep" style={{ margin: '8px 0' }}>
          <strong>{p.title}</strong> <span className="tiny dim">({p.dimensions.join(', ')})</span>
          <ul>{p.findings.slice(0, 3).map((f) => <li key={f.id}>{f.text}</li>)}</ul>
          <div className="tiny"><strong>Play: {p.play.title}.</strong> {p.play.how}</div>
        </section>
      ))}
      <p className="tiny dim">Leads for research, not proof and not advice. Not covered: {run.unavailable.slice(0, 3).join(' ')}</p>
    </article>
  );
}

export function GuideRuns() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [gate, setGate] = useState(0);
  const [sel, setSel] = useState<string[]>([]);
  const nav = useNavigate();
  const load = () => get<{ runs: Item[] }>('/api/guide/runs').then((r) => (r.ok ? setItems(r.data.runs) : setGate(r.status || 500)));
  useEffect(() => { load(); }, []);
  const del = async (id: string) => {
    await fetch(`/api/guide/runs/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    setSel((s) => s.filter((x) => x !== id));
    load();
  };
  return (
    <main style={{ maxWidth: 780, margin: '0 auto', padding: '24px 16px' }}>
      <h1>Saved guide runs</h1>
      <p className="tiny dim">A saved run keeps the figures it was saved with, so a comparison does not shift underneath you. <Link to="/guide">Start a new run</Link></p>
      {gate > 0 && <Gate status={gate} />}
      {items && items.length === 0 && <p>Nothing saved yet. Run the guide and use Save this run.</p>}
      {items && items.length > 0 && (
        <>
          <p><button type="button" className="btn" disabled={sel.length !== 2} onClick={() => nav(`/guide/compare?a=${sel[0]}&b=${sel[1]}`)}>Compare the two ticked runs</button>
            <span className="tiny dim"> {sel.length === 2 ? '' : 'Tick exactly two to compare.'}</span></p>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {items.map((r) => (
              <li key={r.id} style={box}>
                <label><input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, r.id].slice(-2) : s.filter((x) => x !== r.id)))} />{' '}
                  <Link to={`/guide/runs/${r.id}`}><strong>{r.title}</strong></Link></label>
                <div className="tiny dim">Saved {day(r.created_at)}{r.risk ? `, risk ${r.risk}` : ''}{r.budget_usd ? `, budget ${usd(r.budget_usd)}` : ''}
                  {' '}<button type="button" className="link-btn" onClick={() => del(r.id)}>Delete</button></div>
              </li>
            ))}
          </ul>
        </>
      )}
      <style>{PRINT_CSS}</style>
    </main>
  );
}

export function GuideRunView() {
  const { id = '' } = useParams();
  const [d, setD] = useState<{ title: string; saved_at: string; result: Run } | null>(null);
  const [gate, setGate] = useState(0);
  useEffect(() => { get<{ title: string; saved_at: string; result: Run }>(`/api/guide/runs/${encodeURIComponent(id)}`).then((r) => (r.ok ? setD(r.data) : setGate(r.status || 500))); }, [id]);
  return (
    <main style={{ maxWidth: 780, margin: '0 auto', padding: '24px 16px' }}>
      <p className="no-print">
        <Link to="/guide/runs">All saved runs</Link>{' '}
        <button type="button" className="btn" disabled={!d} onClick={() => window.print()}>Save as one-page PDF</button>
        <span className="tiny dim"> Choose Save as PDF in the print window.</span>
      </p>
      {gate > 0 && <Gate status={gate} />}
      {d && <Summary run={d.result} savedAt={d.saved_at} />}
      <p className="tiny dim" style={{ marginTop: 12 }}>Prepared with Tereflow (tereflow.tiwaak.com). Figures come from UN Comtrade and can be revised. Information, not advice.</p>
      <style>{PRINT_CSS}</style>
    </main>
  );
}

export function GuideCompare() {
  const [sp] = useSearchParams();
  const ids = [sp.get('a') ?? '', sp.get('b') ?? ''];
  const [runs, setRuns] = useState<(Run | null)[]>([null, null]);
  const [gate, setGate] = useState(0);
  useEffect(() => {
    Promise.all(ids.map((i) => get<{ result: Run }>(`/api/guide/runs/${encodeURIComponent(i)}`))).then((rs) => {
      const bad = rs.find((r) => !r.ok);
      if (bad && !bad.ok) setGate(bad.status || 500);
      else setRuns(rs.map((r) => (r.ok ? r.data.result : null)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
  const rows: [string, (r: Run) => React.ReactNode][] = [
    ['Country', (r) => r.inputs.country],
    ['View', (r) => (r.inputs.role === 'supply' ? 'Supply' : 'Procurement')],
    ['Budget', (r) => (r.inputs.budget_usd ? usd(r.inputs.budget_usd) : 'not given')],
    ['Risk', (r) => <><strong>{r.risk.level}</strong><div className="tiny dim">{r.risk.reasons.join(' ')}</div></>],
    ['Indicative return', (r) => (r.estimate.available ? `${usd(r.estimate.low_usd)} to ${usd(r.estimate.high_usd)}` : 'unavailable')],
    ['Problems found', (r) => (r.problems.length ? <ul>{r.problems.map((p) => <li key={p.key}>{p.title}</li>)}</ul> : 'none')],
    ['Main buyers or suppliers', (r) => r.chain.find((c) => c.from_data && /buyer|market|supplier|source/i.test(c.stage))?.actors.join(', ') ?? 'not held'],
    ['Findings fired', (r) => String(r.findings.length)],
  ];
  const [a, b] = runs;
  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: '24px 16px' }}>
      <p className="no-print"><Link to="/guide/runs">All saved runs</Link> <button type="button" className="btn" onClick={() => window.print()}>Save as PDF</button></p>
      <h1>Compare runs</h1>
      {gate > 0 && <Gate status={gate} />}
      {a && b && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={{ textAlign: 'left' }} /><th style={{ textAlign: 'left' }}>{a.inputs.product}</th><th style={{ textAlign: 'left' }}>{b.inputs.product}</th></tr></thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label} style={{ borderTop: '1px solid var(--line, #cfd4dc)', verticalAlign: 'top' }}>
                <th style={{ textAlign: 'left', padding: '8px 8px 8px 0', width: 150 }}>{label}</th>
                <td style={{ padding: 8 }}>{f(a)}</td>
                <td style={{ padding: 8 }}>{f(b)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="tiny dim">Each column is the run as it was saved. Risk and return come from the same fixed rules for both, so the two are comparable. Leads for research, not advice.</p>
      <style>{PRINT_CSS}</style>
    </main>
  );
}
