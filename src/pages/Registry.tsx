import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';
import {
  CATEGORY_LABEL,
  KIND_LABEL,
  linkHealth,
  LINK_HEALTH_LABEL,
  type EntityWithSources,
  type SourceCategory,
} from '../../shared/types';

type Filter = 'all' | 'country' | 'intl_org' | 'regional_body';

export default function Registry() {
  const [entities, setEntities] = useState<EntityWithSources[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .registry()
      .then((r) => setEntities(r.entities))
      .catch(() => setEntities([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entities.filter(
      (e) =>
        (filter === 'all' || e.kind === filter) &&
        (!needle ||
          e.name.toLowerCase().includes(needle) ||
          (e.agency_name ?? '').toLowerCase().includes(needle) ||
          (e.iso3 ?? '').toLowerCase().includes(needle)),
    );
  }, [entities, filter, q]);

  const linkTotal = useMemo(
    () =>
      entities.reduce(
        (a, e) => a + e.sources.export.length + e.sources.import.length + e.sources.commerce.length,
        0,
      ),
    [entities],
  );

  if (loading) return <Skeletons n={6} />;

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Every official publication this platform reads from. {entities.length} bodies, {linkTotal}{' '}
        links, re-checked on every pipeline run.
      </p>

      <input
        type="search"
        placeholder="Search bodies, agencies, ISO codes"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <Chips
        options={[
          { value: 'all' as Filter, label: `All (${entities.length})` },
          {
            value: 'country' as Filter,
            label: `Countries (${entities.filter((e) => e.kind === 'country').length})`,
          },
          {
            value: 'intl_org' as Filter,
            label: `International (${entities.filter((e) => e.kind === 'intl_org').length})`,
          },
          {
            value: 'regional_body' as Filter,
            label: `Regional (${entities.filter((e) => e.kind === 'regional_body').length})`,
          },
        ]}
        value={filter}
        onChange={setFilter}
      />

      <div style={{ height: 14 }} />

      {filtered.length === 0 ? (
        <Empty title="Nothing matches that search" />
      ) : (
        filtered.map((e) => {
          const count =
            e.sources.export.length + e.sources.import.length + e.sources.commerce.length;
          const isOpen = open === e.slug;
          return (
            <div className="card tight" key={e.slug} style={{ marginBottom: 8 }}>
              <button
                onClick={() => setOpen(isOpen ? null : e.slug)}
                style={{
                  background: 'none',
                  border: 0,
                  color: 'inherit',
                  padding: 0,
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <div className="row" style={{ gap: 11 }}>
                  <span className="flag">{e.iso3 ?? (e.kind === 'country' ? '??' : '◍')}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="name" style={{ display: 'block' }}>
                      {e.name}
                    </span>
                    <span className="tiny dim">
                      {KIND_LABEL[e.kind]} · {count} link{count === 1 ? '' : 's'}
                      {e.is_active ? ' · live' : ''}
                    </span>
                  </span>
                  <span className="dim">{isOpen ? '⌃' : '⌄'}</span>
                </div>
              </button>

              {isOpen && (
                <div style={{ marginTop: 12 }}>
                  {e.agency_name && (
                    <p className="tiny dim" style={{ marginTop: 0 }}>
                      {e.agency_name}
                    </p>
                  )}
                  {(['export', 'import', 'commerce'] as SourceCategory[]).map((cat) =>
                    e.sources[cat].length ? (
                      <div key={cat} style={{ marginBottom: 10 }}>
                        <p className="card-title" style={{ marginBottom: 6 }}>
                          {CATEGORY_LABEL[cat]}
                        </p>
                        {e.sources[cat].map((s) => (
                          <a
                            className="src-link"
                            key={s.id}
                            href={s.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={LINK_HEALTH_LABEL[linkHealth(s.last_status, s.fmt)]}
                          >
                            <span className={`dot ${linkHealth(s.last_status, s.fmt)}`} />
                            <span className="u">{s.label ?? s.url}</span>
                            <span className="tiny dim">{s.fmt}</span>
                          </a>
                        ))}
                      </div>
                    ) : null,
                  )}
                  {e.api_notes && (
                    <p className="tiny dim" style={{ marginBottom: 0 }}>
                      ⓘ {e.api_notes}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
