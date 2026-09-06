import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getAdminToken } from '../lib/api';
import { Empty, Skeletons, useToast } from '../components/ui';
import {
  EXPORT_CATEGORY_LABEL,
  type Entity,
  type ExportCategory,
  type ResolvedClassification,
} from '../../shared/types';

const SOURCE_LABEL: Record<ResolvedClassification['source'], string> = {
  default: 'Universal default',
  heuristic: "This country's dominant export",
  override: 'Admin override',
};

export default function AdminClassifications() {
  const [countries, setCountries] = useState<Entity[]>([]);
  const [entitySlug, setEntitySlug] = useState('*');
  const [rows, setRows] = useState<ResolvedClassification[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ResolvedClassification | null>(null);
  const t = useToast();

  useEffect(() => {
    if (!getAdminToken()) return;
    api.admin
      .list({ kind: 'country' })
      .then((r) => setCountries(r.entities))
      .catch(() => setCountries([]));
  }, []);

  useEffect(() => {
    if (!getAdminToken()) return;
    setLoading(true);
    api.admin
      .classifications(entitySlug)
      .then((r) => setRows(r.rows))
      .catch((e) => t.err((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitySlug]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (r) => r.label.toLowerCase().includes(needle) || r.hs_code.includes(needle),
    );
  }, [rows, q]);

  async function save(hsCode: string, category: ExportCategory, note: string, sourceUrl: string) {
    try {
      await api.admin.setClassification({
        entity: entitySlug,
        hs_code: hsCode,
        category,
        note: note.trim() || null,
        source_url: sourceUrl.trim() || null,
      });
      t.ok(`HS ${hsCode} saved`);
      setEditing(null);
      const r = await api.admin.classifications(entitySlug);
      setRows(r.rows);
    } catch (e) {
      t.err((e as Error).message);
    }
  }

  async function revert(hsCode: string) {
    try {
      await api.admin.clearClassification(entitySlug, hsCode);
      t.ok(`HS ${hsCode} reverted to default`);
      const r = await api.admin.classifications(entitySlug);
      setRows(r.rows);
    } catch (e) {
      t.err((e as Error).message);
    }
  }

  if (!getAdminToken()) {
    return (
      <div className="card">
        <p className="card-title">Sign in required</p>
        <p className="small dim">
          Sign in on the main <Link to="/admin">Admin</Link> page first, then come back here.
        </p>
      </div>
    );
  }

  return (
    <>
      {t.node}

      <p className="small muted" style={{ marginTop: 0 }}>
        Traditional exports are capital-intensive, licensed, or state/oligopoly-controlled —
        realistically closed to a new small exporter (oil, mining, precious metals, and — per
        country — a dominant legacy commodity). Everything else is a Non-Traditional Export
        (NTE), the same distinction real export-promotion agencies use. Choose{' '}
        <strong>Universal default</strong> to edit the rule that applies to every country, or a
        specific country to curate a sourced override for it.
      </p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <select value={entitySlug} onChange={(e) => setEntitySlug(e.target.value)} style={{ flex: 1 }}>
          <option value="*">Universal default (every country)</option>
          {countries.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <input
        type="search"
        placeholder="Search a product name or HS chapter"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      {loading ? (
        <Skeletons n={6} />
      ) : filtered.length === 0 ? (
        <Empty title="No chapters match" />
      ) : (
        filtered.map((r) => (
          <div className="list-item" key={r.hs_code} style={{ display: 'block', cursor: 'default' }}>
            <div className="row between">
              <span className="grow">
                <span className="name">
                  HS {r.hs_code} · {r.label}
                </span>
                <span className="tiny dim">{SOURCE_LABEL[r.source]}</span>
              </span>
              <span className={`badge ${r.category === 'traditional' ? 'watch' : 'on'}`}>
                {EXPORT_CATEGORY_LABEL[r.category]}
              </span>
            </div>

            {editing?.hs_code === r.hs_code ? (
              <ClassificationForm
                row={r}
                onCancel={() => setEditing(null)}
                onSave={(category, note, sourceUrl) => save(r.hs_code, category, note, sourceUrl)}
              />
            ) : (
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn ghost sm" onClick={() => setEditing(r)}>
                  {entitySlug === '*' ? 'Edit default' : 'Override for this country'}
                </button>
                {entitySlug !== '*' && r.override && (
                  <button className="btn ghost sm" onClick={() => revert(r.hs_code)}>
                    Revert to default
                  </button>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </>
  );
}

function ClassificationForm({
  row,
  onSave,
  onCancel,
}: {
  row: ResolvedClassification;
  onSave: (category: ExportCategory, note: string, sourceUrl: string) => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState<ExportCategory>(row.category);
  const [note, setNote] = useState(row.override?.note ?? '');
  const [sourceUrl, setSourceUrl] = useState(row.override?.source_url ?? '');

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
      <div className="field">
        <label>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value as ExportCategory)}>
          <option value="non_traditional">Non-traditional export</option>
          <option value="traditional">Traditional export</option>
        </select>
      </div>
      <div className="field">
        <label>Note (why)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. GEPA's published NTE list" />
      </div>
      <div className="field">
        <label>Source URL</label>
        <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://..." />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary sm" onClick={() => onSave(category, note, sourceUrl)}>
          Save
        </button>
        <button className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
