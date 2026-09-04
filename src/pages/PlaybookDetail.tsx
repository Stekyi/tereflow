import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';
import { Markdown } from '../components/Markdown';
import type { Playbook } from '../../shared/types';

export default function PlaybookDetail() {
  const { slug = '' } = useParams();
  const [book, setBook] = useState<Playbook | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.premium
      .playbook(slug)
      .then((r) => setBook(r.playbook))
      .catch(() => setBook(null))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) return <Skeletons n={5} />;
  if (!book) return <Empty title="That playbook is not available" />;

  return (
    <>
      <h2 style={{ fontSize: 22, letterSpacing: '-0.03em', margin: '0 0 6px', lineHeight: 1.2 }}>
        {book.title}
      </h2>
      <div className="tiny dim" style={{ marginBottom: 14 }}>
        {book.reading_minutes} min read
        {book.sector ? ` · ${book.sector}` : ''}
        {book.country_iso3 ? ` · ${book.country_iso3}` : ''}
        {book.locked ? ' · preview' : ''}
      </div>

      {book.summary && (
        <div className="card tight">
          <p className="small muted" style={{ margin: 0 }}>
            {book.summary}
          </p>
        </div>
      )}

      <div className="card">
        <Markdown source={book.body_md} />
      </div>

      {book.locked && (
        <div className="locked">
          <div style={{ fontSize: 24 }}>🔒</div>
          <h3>The rest of this playbook is premium</h3>
          <p>
            The remaining steps cover the documentation, the certifications and the payment terms
            that decide whether a first shipment actually clears.
          </p>
          <Link className="btn primary" to="/upgrade">
            See premium
          </Link>
        </div>
      )}

      {book.sources.length > 0 && (
        <>
          <div className="section-head">
            <h2>Sources</h2>
          </div>
          <div className="card">
            <p className="tiny dim" style={{ marginTop: 0 }}>
              Everything above is taken from these publications. Nothing here is attributed to an
              individual, and nothing is invented.
            </p>
            {book.sources.map((s) => (
              <a
                className="src-link"
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                <span className="u">{s.title}</span>
                <span className="tiny dim">{s.publisher}</span>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}
