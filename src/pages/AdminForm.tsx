import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Skeletons, Toggle, useToast } from '../components/ui';
import {
  CATEGORY_LABEL,
  CONTINENTS,
  ENTITY_KINDS,
  KIND_LABEL,
  SOURCE_CATEGORIES,
  SOURCE_ENDPOINT_TYPES,
  SOURCE_FMTS,
  SOURCE_PARSERS,
  type EntityInput,
  type EntityKind,
  type SourceCategory,
  type SourceEndpointType,
  type SourceFmt,
  type SourceParserKey,
} from '../../shared/types';

interface SlotState {
  url: string;
  label: string;
  fmt: SourceFmt;
  endpoint_type: SourceEndpointType;
  parser_key: SourceParserKey;
  config_json: string;
}

type SourceState = Record<SourceCategory, [SlotState, SlotState, SlotState]>;

const blankSlot = (): SlotState => ({
  url: '',
  label: '',
  fmt: 'html',
  endpoint_type: 'file',
  parser_key: 'auto',
  config_json: '{}',
});
const blankSources = (): SourceState => ({
  export: [blankSlot(), blankSlot(), blankSlot()],
  import: [blankSlot(), blankSlot(), blankSlot()],
  commerce: [blankSlot(), blankSlot(), blankSlot()],
});

const CATEGORY_HINT: Record<SourceCategory, string> = {
  export:
    'Where this body publishes export data. First link should be the most machine-readable one.',
  import: 'Where it publishes import data.',
  commerce:
    'Commerce measured inside the country: trade in services, wholesale and retail activity, or GDP by economic activity.',
};

export default function AdminForm() {
  const { slug } = useParams();
  const editing = Boolean(slug);
  const navigate = useNavigate();
  const t = useToast();

  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<EntityKind>('country');
  const [continent, setContinent] = useState<string>('Africa');
  const [iso3, setIso3] = useState('');
  const [agency, setAgency] = useState('');
  const [homepage, setHomepage] = useState('');
  const [notes, setNotes] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [sources, setSources] = useState<SourceState>(blankSources());

  useEffect(() => {
    if (!slug) return;
    api
      .admin
      .get(slug)
      .then((e) => {
        setName(e.name);
        setKind(e.kind);
        setContinent(e.continent ?? 'Africa');
        setIso3(e.iso3 ?? '');
        setAgency(e.agency_name ?? '');
        setHomepage(e.homepage ?? '');
        setNotes(e.api_notes ?? '');
        setIsActive(e.is_active === 1);
        const next = blankSources();
        for (const cat of SOURCE_CATEGORIES) {
          for (const s of e.sources[cat]) {
            const idx = s.slot - 1;
            if (idx >= 0 && idx < 3)
              next[cat][idx] = {
                url: s.url,
                label: s.label ?? '',
                fmt: s.fmt,
                endpoint_type: s.endpoint_type ?? 'file',
                parser_key: s.parser_key ?? 'auto',
                config_json: s.config_json ?? '{}',
              };
          }
        }
        setSources(next);
      })
      .catch((err: Error) => t.err(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function setSlot(cat: SourceCategory, idx: number, patch: Partial<SlotState>) {
    setSources((prev) => {
      const copy: SourceState = {
        export: [...prev.export] as SourceState['export'],
        import: [...prev.import] as SourceState['import'],
        commerce: [...prev.commerce] as SourceState['commerce'],
      };
      copy[cat][idx] = { ...copy[cat][idx], ...patch };
      return copy;
    });
  }

  async function save() {
    if (!name.trim()) return t.err('Name is required');
    if (kind === 'country' && iso3.trim().length !== 3)
      return t.err('Countries need a 3-letter ISO code so the pipeline can find their data');

    const payload: EntityInput = {
      name: name.trim(),
      kind,
      continent: kind === 'country' ? continent : continent || 'Global',
      iso3: iso3.trim() ? iso3.trim().toUpperCase() : null,
      agency_name: agency.trim() || null,
      homepage: homepage.trim() || null,
      api_notes: notes.trim() || null,
      is_active: isActive,
      sources: SOURCE_CATEGORIES.flatMap((cat) =>
        sources[cat]
          .map((s, i) => ({ ...s, slot: (i + 1) as 1 | 2 | 3, category: cat }))
          .filter((s) => s.url.trim())
          .map((s) => ({
            category: s.category,
            slot: s.slot,
            url: s.url.trim(),
            label: s.label.trim() || null,
            fmt: s.fmt,
            endpoint_type: s.endpoint_type,
            parser_key: s.parser_key,
            config_json: s.config_json.trim() || '{}',
          })),
      ),
    };

    setSaving(true);
    try {
      if (editing && slug) await api.admin.update(slug, payload);
      else await api.admin.create(payload);
      t.ok('Saved');
      setTimeout(() => navigate('/admin'), 500);
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!slug) return;
    if (!confirm(`Delete ${name}? This removes its links and analysis too.`)) return;
    try {
      await api.admin.remove(slug);
      navigate('/admin');
    } catch (e) {
      t.err((e as Error).message);
    }
  }

  if (loading) return <Skeletons n={6} />;

  return (
    <>
      {t.node}

      <div className="card">
        <p className="card-title">Record</p>

        <div className="field">
          <label htmlFor="kind">Type</label>
          <select
            id="kind"
            value={kind}
            onChange={(e) => {
              const k = e.target.value as EntityKind;
              setKind(k);
              if (k !== 'country') setContinent('Global');
              else if (continent === 'Global') setContinent('Africa');
            }}
          >
            {ENTITY_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <div className="help">
            Countries, international organisations and regional bodies all publish trade data, so
            they share one registry.
          </div>
        </div>

        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === 'country' ? 'Ghana' : 'ECOWAS Trade Information System'}
          />
        </div>

        <div className="grid two-md">
          <div className="field">
            <label htmlFor="continent">{kind === 'country' ? 'Continent' : 'Region covered'}</label>
            <select
              id="continent"
              value={continent}
              onChange={(e) => setContinent(e.target.value)}
            >
              {CONTINENTS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="iso3">
              ISO3 code {kind === 'country' ? '(required)' : '(optional)'}
            </label>
            <input
              id="iso3"
              type="text"
              maxLength={3}
              value={iso3}
              onChange={(e) => setIso3(e.target.value.toUpperCase())}
              placeholder="GHA"
              style={{ textTransform: 'uppercase' }}
            />
            <div className="help">Used to match this record against harmonised trade data.</div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="agency">Statistical service / publishing agency</label>
          <input
            id="agency"
            type="text"
            value={agency}
            onChange={(e) => setAgency(e.target.value)}
            placeholder="Ghana Statistical Service"
          />
        </div>

        <div className="field">
          <label htmlFor="homepage">Homepage</label>
          <input
            id="homepage"
            type="url"
            value={homepage}
            onChange={(e) => setHomepage(e.target.value)}
            placeholder="https://statsghana.gov.gh/"
          />
        </div>
      </div>

      {SOURCE_CATEGORIES.map((cat) => (
        <div className="card" key={cat}>
          <p className="card-title">{CATEGORY_LABEL[cat]}</p>
          <p className="small dim" style={{ marginTop: -6, marginBottom: 12 }}>
            {CATEGORY_HINT[cat]}
          </p>
          <div className="link-slots">
            {sources[cat].map((s, i) => (
              <div className="slot" key={i}>
                <div className="slot-label">Link {i + 1}</div>
                <input
                  type="url"
                  value={s.url}
                  onChange={(e) => setSlot(cat, i, { url: e.target.value })}
                  placeholder={i === 0 ? 'https://…' : 'Overflow link (optional)'}
                />
                <input
                  type="text"
                  value={s.label}
                  onChange={(e) => setSlot(cat, i, { label: e.target.value })}
                  placeholder="What is this link?"
                />
                <select
                  value={s.fmt}
                  onChange={(e) => setSlot(cat, i, { fmt: e.target.value as SourceFmt })}
                >
                  {SOURCE_FMTS.map((f) => (
                    <option key={f} value={f}>
                      {f.toUpperCase()}
                    </option>
                  ))}
                </select>
                <select
                  value={s.endpoint_type}
                  onChange={(e) =>
                    setSlot(cat, i, { endpoint_type: e.target.value as SourceEndpointType })
                  }
                >
                  {SOURCE_ENDPOINT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      endpoint: {type}
                    </option>
                  ))}
                </select>
                <select
                  value={s.parser_key}
                  onChange={(e) => setSlot(cat, i, { parser_key: e.target.value as SourceParserKey })}
                >
                  {SOURCE_PARSERS.map((parser) => (
                    <option key={parser} value={parser}>
                      parser: {parser}
                    </option>
                  ))}
                </select>
                <textarea
                  value={s.config_json}
                  onChange={(e) => setSlot(cat, i, { config_json: e.target.value })}
                  placeholder='{"rows_path":"data","year":"year","flow":"flow","value_usd":"value_usd","hs_code":"hs_code"}'
                  aria-label="Parser field mapping JSON"
                />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="card">
        <p className="card-title">Notes</p>
        <div className="field">
          <label htmlFor="notes">Access notes</label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Is there an API? Does it need a key? Rate limits, bulk download, licence."
          />
        </div>
      </div>

      <div className="card">
        <div className="row between">
          <div>
            <div style={{ fontWeight: 650 }}>Activated</div>
            <div className="tiny dim" style={{ maxWidth: 420 }}>
              When ticked, the weekly agent reads this record's data, pulls the matching slices from
              the international and regional bodies, analyses it, and publishes a dashboard.
            </div>
          </div>
          <Toggle checked={isActive} onChange={setIsActive} />
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={save} disabled={saving} style={{ flex: 1 }}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create record'}
        </button>
        {editing && (
          <button className="btn danger" onClick={remove} disabled={saving}>
            Delete
          </button>
        )}
      </div>
    </>
  );
}
