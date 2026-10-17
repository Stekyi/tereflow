import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { ProductCard } from '../../shared/types';
import type { GuideResult } from '../../shared/guide';

interface Target { hs: string; name: string; via?: string; note?: string }
interface Mapped { id: string; kind: string; confidence: string; by_name: string; by_code: string | null; parent_name: string; parent_code: string | null; matched_on: string }

type CountrySummary = Awaited<ReturnType<typeof api.countries>>['countries'][number];

type Answer =
  | { locked: true; title: string; teaser: string }
  | { locked: false; available: false; reason: string }
  | ({ locked: false; available: true; inputs: { country: string; product: string; hs: string; role: string; budget_usd: number | null }; lens: { name: string; kind: string; confidence: string; parent_name: string; shown_through: 'own_code' | 'parent'; note: string } | null; sources: string[] } & GuideResult);

const STEPS = ['Your starting point', 'Trace the chain', 'Where it strains', 'Group by dimension', 'Merge into problems', 'Questions and plays'];
const usd = (n: number | null) => (n == null ? 'unavailable' : `$${Math.round(n).toLocaleString('en-US')}`);
const box = { border: '1px solid var(--line, #cfd4dc)', borderRadius: 8, padding: '12px 14px', margin: '10px 0' } as const;

export default function Guide() {
  const [countries, setCountries] = useState<CountrySummary[]>([]);
  const [slug, setSlug] = useState('');
  const [role, setRole] = useState<'supply' | 'procurement'>('supply');
  const [q, setQ] = useState('');
  const [cards, setCards] = useState<ProductCard[]>([]);
  const [pick, setPick] = useState<Target | null>(null);
  const [maps, setMaps] = useState<Mapped[]>([]);
  const [budget, setBudget] = useState('');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ans, setAns] = useState<Answer | 'failed' | null>(null);

  useEffect(() => { api.countries().then((r) => setCountries(r.countries.filter((c) => c.is_active))).catch(() => {}); }, []);
  useEffect(() => {
    if (!slug || q.trim().length < 2) { setCards([]); setMaps([]); return; }
    let live = true;
    const t = setTimeout(() => {
      if (q.trim().length >= 3) fetch(`/api/resolve?q=${encodeURIComponent(q.trim())}`).then((r) => (r.ok ? r.json() : { matches: [] })).then((r: { matches: Mapped[] }) => { if (live) setMaps(r.matches); }).catch(() => {});
      api.products({ q: q.trim(), country: slug, flow: role === 'supply' ? 'export' : 'import', limit: 12 })
        .then((r) => { if (live) setCards(r.products.filter((p) => /^\d{6}$/.test(p.hs_code))); }).catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, slug, role]);

  const run = async () => {
    if (!pick) return;
    setBusy(true); setAns(null);
    const qs = new URLSearchParams({ role });
    if (pick.via) qs.set('via', pick.via);
    if (Number(budget) > 0) qs.set('budget', String(Number(budget)));
    try {
      const res = await fetch(`/api/guide/${encodeURIComponent(slug)}/${pick.hs}?${qs}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      setAns(res.ok ? ((await res.json()) as Answer) : 'failed');
      setStep(1);
    } catch { setAns('failed'); }
    setBusy(false);
  };

  const ready = !!slug && !!pick;
  const options: Target[] = maps.filter((m) => m.matched_on === 'byproduct').flatMap((m) => {
    const out: Target[] = [];
    if (m.parent_code && /^\d{6}$/.test(m.parent_code)) out.push({ hs: m.parent_code, via: m.id, name: `${m.by_name}, a ${m.kind} of ${m.parent_name}: analyse through ${m.parent_name} (HS ${m.parent_code})` });
    if (m.by_code && /^\d{6}$/.test(m.by_code)) out.push({ hs: m.by_code, via: m.id, name: `${m.by_name}: its own trade code (HS ${m.by_code}, ${m.confidence} link)` });
    return out;
  });
  const a = ans && ans !== 'failed' && !ans.locked && ans.available ? ans : null;

  return (
    <main style={{ maxWidth: 780, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ marginBottom: 4 }}>Problem to supply guide</h1>
      <p className="tiny dim">
        Pick a product and a country, and the guide walks five steps: trace the chain, find where the trade strains, group the findings by PESTEL dimension, merge them into problems, then turn each into research questions and a supply or procurement play.
        It runs fixed rules over trade data we hold. It uses no language model, the same inputs always give the same answer, and every line shows the numbers behind it. The framework steps organise evidence for research. They are leads, not proof and not advice.
      </p>

      <ol style={{ display: 'flex', flexWrap: 'wrap', gap: 6, listStyle: 'none', padding: 0, margin: '12px 0' }}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" className="btn" disabled={i > 0 && !a} aria-current={step === i ? 'step' : undefined}
              style={{ fontWeight: step === i ? 700 : 400 }} onClick={() => setStep(i)}>{i + 1}. {s}</button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section style={box}>
          <label>I want to <select value={role} onChange={(e) => { setRole(e.target.value as 'supply' | 'procurement'); setPick(null); setCards([]); setMaps([]); }}>
            <option value="supply">supply (sell goods out of a country)</option>
            <option value="procurement">procure (bring goods into a country)</option>
          </select></label>
          <p><label>Country{' '}
            <select value={slug} onChange={(e) => { setSlug(e.target.value); setPick(null); }}>
              <option value="">Choose</option>
              {countries.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
            </select></label></p>
          <p><label>Product{' '}
            <input value={pick ? pick.name : q} onChange={(e) => { setPick(null); setQ(e.target.value); }} placeholder="Type a product, for example cocoa" disabled={!slug} />
          </label></p>
          {!pick && (cards.length > 0 || options.length > 0) && (
            <div>
              {options.length > 0 && <p className="tiny dim" style={{ margin: '6px 0' }}>Made from, or left over from, a main product</p>}
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {options.map((o) => <li key={`${o.hs}|${o.via}`}><button type="button" className="btn" onClick={() => setPick(o)}>{o.name}</button></li>)}
              </ul>
              {cards.length > 0 && <p className="tiny dim" style={{ margin: '6px 0' }}>Traded products</p>}
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {cards.map((c) => <li key={c.hs_code}><button type="button" className="btn" onClick={() => setPick({ hs: c.hs_code, name: `${c.name} (HS ${c.hs_code})` })}>{c.name} (HS {c.hs_code})</button></li>)}
              </ul>
            </div>
          )}
          <p><label>Budget in US dollars (optional, used only for the return range){' '}
            <input inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))} placeholder="for example 50000" /></label></p>
          <button type="button" className="btn" disabled={!ready || busy} onClick={run}>{busy ? 'Working it out' : 'Walk me through it'}</button>
          {ans === 'failed' && <p>The guide could not be built right now. Try again in a moment.</p>}
          {ans && ans !== 'failed' && ans.locked && (
            <p style={box}>{ans.teaser} <Link to="/upgrade">See premium</Link></p>
          )}
          {ans && ans !== 'failed' && !ans.locked && !ans.available && <p>{ans.reason}</p>}
        </section>
      )}

      {a && step === 1 && (
        <section style={box}>
          <h2>1. The chain for {a.inputs.product}</h2>
          {a.lens && <p style={{ ...box, background: 'rgba(120,120,120,.08)' }}>{a.lens.note}</p>}
          <p className="tiny dim">Stages are a standard product chain. Names appear only where trade data gives them; roles are marked as not held.</p>
          {a.chain.map((c) => (
            <div key={c.stage} style={{ margin: '8px 0' }}>
              <strong>{c.stage}</strong> <span className="tiny dim">{c.from_data ? 'from trade data' : 'role only, not held'}</span>
              <div>{c.actors.join(', ')}</div>
            </div>
          ))}
        </section>
      )}

      {a && step === 2 && (
        <section style={box}>
          <h2>2. Where the trade strains</h2>
          {a.findings.length === 0 && <p>No rule fired on the data held. That is not the same as no problem.</p>}
          {a.findings.map((f) => (
            <div key={f.id} style={{ margin: '10px 0' }}>
              <div>{f.text}</div>
              {f.evidence.map((e) => <div key={e} className="tiny dim">{e}</div>)}
            </div>
          ))}
        </section>
      )}

      {a && step === 3 && (
        <section style={box}>
          <h2>3. Grouped by PESTEL dimension</h2>
          <p className="tiny dim">Which dimension a finding sits in is a fixed Tereflow rule. Dimensions with nothing found are left out; Legal needs tariff and rules data we do not hold yet.</p>
          {a.by_dimension.map((d) => (
            <div key={d.dimension} style={{ margin: '8px 0' }}><strong>{d.dimension}</strong><ul>{d.findings.map((f) => <li key={f.id}>{f.text}</li>)}</ul></div>
          ))}
        </section>
      )}

      {a && step === 4 && (
        <section style={box}>
          <h2>4. Merged into problems</h2>
          <p className="tiny dim">Findings that point at the same underlying problem are merged. Each problem lists the dimensions it spans.</p>
          {a.problems.map((p) => (
            <div key={p.key} style={{ margin: '10px 0' }}><strong>{p.title}</strong> <span className="tiny dim">({p.dimensions.join(', ')})</span>
              <ul>{p.findings.map((f) => <li key={f.id}>{f.text}</li>)}</ul></div>
          ))}
          {a.problems.length === 0 && <p>No problem could be formed from the data held.</p>}
        </section>
      )}

      {a && step === 5 && (
        <section>
          {a.problems.map((p) => (
            <div key={p.key} style={box}>
              <h3 style={{ marginTop: 0 }}>{p.title}</h3>
              <strong>Research questions</strong>
              <ol>{p.research_questions.map((x) => <li key={x}>{x}</li>)}</ol>
              <strong>Play: {p.play.title}</strong>
              <p>{p.play.how}</p>
              <p><em>When:</em> {p.play.when}</p>
              <p><em>Risks:</em></p><ul>{p.play.risks.map((x) => <li key={x}>{x}</li>)}</ul>
              <p><em>Reward:</em> {p.play.reward}</p>
            </div>
          ))}
          <div style={box}>
            <h3 style={{ marginTop: 0 }}>Risk and return</h3>
            <p><strong>Risk: {a.risk.level}.</strong> {a.risk.reasons.join(' ')}</p>
            {a.estimate.available
              ? <p><strong>Indicative return on {usd(a.inputs.budget_usd)}: {usd(a.estimate.low_usd)} to {usd(a.estimate.high_usd)}.</strong></p>
              : <p><strong>Return estimate: unavailable.</strong></p>}
            <ul>{a.estimate.basis.map((x) => <li key={x}>{x}</li>)}{a.estimate.caveats.map((x) => <li key={x}>{x}</li>)}</ul>
            <p className="tiny dim">Timing: seasonality for this product is on its feasibility report. <Link to={`/feasibility/${slug}/${a.inputs.hs}?flow=${role === 'supply' ? 'export' : 'import'}`}>Open it</Link> and the landed cost calculator on the product page to replace the cost allowance.</p>
          </div>
          <div style={box}>
            <h3 style={{ marginTop: 0 }}>Not covered</h3>
            <ul>{a.unavailable.map((x) => <li key={x}>{x}</li>)}</ul>
            <h3>Method</h3>
            <ul>{a.method.map((x) => <li key={x}>{x}</li>)}</ul>
            <h3>Sources</h3>
            <ul>{a.sources.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        </section>
      )}
      <style>{'@media print{.btn,nav,header,footer{display:none!important}}'}</style>
    </main>
  );
}
