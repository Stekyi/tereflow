import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { ProductInsight } from '../../shared/types';
import {
  ReexportBlock, SeasonalityBlock, SupplyBlock, RegulatoryBlock, DiscoveryBlock, ProductionBlock,
} from '../components/ProductModal';

export default function Feasibility() {
  const { slug = '', hs = '' } = useParams();
  const [sp] = useSearchParams();
  const flow = sp.get('flow') === 'import' ? 'import' : 'export';
  const [insight, setInsight] = useState<ProductInsight | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    api.insight(hs, slug, flow).then((d) => { if (live) setInsight(d); }).catch(() => { if (live) setInsight('failed'); });
    return () => { live = false; };
  }, [hs, slug, flow]);

  if (insight === null) return <p className="tiny dim">Building the report.</p>;
  if (insight === 'failed') return <p>This report could not be built right now.</p>;
  const sec = { margin: '18px 0', padding: '0 0 12px', borderBottom: '1px solid var(--line, #cfd4dc)' } as const;
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ marginBottom: 4 }}>Feasibility report: {insight.name}</h1>
      <p className="tiny dim">HS {insight.hs_code}, {flow === 'import' ? 'import' : 'export'} view, {slug}. Generated {new Date().toISOString().slice(0, 10)}. Every section shows its source and limits. A missing section means the data is not held, not that the answer is no.</p>
      <button type="button" className="btn no-print" onClick={() => window.print()}>Print or save as PDF</button>
      <section style={sec}><h2>1. Re-export pattern</h2>{insight.reexport ? <ReexportBlock signal={insight.reexport} /> : <p className="tiny dim">Not available: needs both export and import history for this country and product.</p>}</section>
      <section style={sec}><h2>2. Seasonality</h2><SeasonalityBlock signal={insight.seasonality ?? null} /></section>
      <section style={sec}><h2>3. Supply concentration</h2>{insight.supply ? <SupplyBlock signal={insight.supply} /> : <p className="tiny dim">Not available: no partner breakdown held.</p>}</section>
      <section style={sec}><h2>4. Import rules (UK)</h2><RegulatoryBlock hs={insight.hs_code} /></section>
      <section style={sec}><h2>5. Domestic production</h2><ProductionBlock slug={slug} hs={insight.hs_code} /><p className="tiny dim">Shown only for the 19 crops matched to FAOSTAT.</p></section>
      <section style={sec}><h2>6. Who trades this on Tereflow</h2><DiscoveryBlock hs={insight.hs_code} /></section>
      <style>{'@media print{.no-print,nav,header,footer{display:none!important}}'}</style>
    </main>
  );
}