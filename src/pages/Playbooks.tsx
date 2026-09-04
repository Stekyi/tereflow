import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';
import { SECTOR_OPTIONS, type PlaybookSummary } from '../../shared/types';

export default function Playbooks() {
  const [books, setBooks] = useState<PlaybookSummary[]>([]);
  const [sector, setSector] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.premium
      .playbooks(sector ? { sector } : {})
      .then((r) => setBooks(r.playbooks))
      .catch(() => setBooks([]))
      .finally(() => setLoading(false));
  }, [sector]);

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        How to actually start, drawn from the institutions that write the rules: the International
        Trade Centre, the European Commission, the US FDA, the AfCFTA Secretariat and national
        export agencies. Every claim carries its source.
      </p>

      <Chips
        options={[
          { value: '', label: 'All' },
          ...SECTOR_OPTIONS.slice(0, 8).map((s) => ({ value: s, label: s })),
        ]}
        value={sector}
        onChange={setSector}
      />
      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={5} />
      ) : books.length === 0 ? (
        <Empty title="No playbooks for that filter" />
      ) : (
        books.map((p) => (
          <Link className="list-item" key={p.slug} to={`/playbooks/${p.slug}`}>
            <span className="grow">
              <span className="name">{p.title}</span>
              <span className="tiny dim">{p.summary}</span>
              <span className="tiny" style={{ marginTop: 4 }}>
                {p.locked ? (
                  <span className="badge premium">Premium</span>
                ) : (
                  <span className="badge on">Free</span>
                )}
                <span className="dim" style={{ marginLeft: 7 }}>
                  {p.reading_minutes} min read
                  {p.sector ? ` · ${p.sector}` : ''}
                  {p.country_iso3 ? ` · ${p.country_iso3}` : ''}
                </span>
              </span>
            </span>
            <span className="dim">›</span>
          </Link>
        ))
      )}
    </>
  );
}
