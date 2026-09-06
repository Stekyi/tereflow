import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons, useToast } from '../components/ui';
import { FEEDBACK_KIND_LABEL, type FeedbackKind } from '../../shared/types';

type Row = Awaited<ReturnType<typeof api.admin.feedback>>['feedback'][number];
type Filter = 'new' | 'read' | 'done' | 'all';

/**
 * What people sent through the floating button.
 *
 * Deliberately plain: a list, a status, and a way to close an item. Feedback
 * that nobody reads is worse than no feedback button, and anything more than
 * this is a support system, which is a decision to make on purpose rather
 * than by accident.
 */
export default function AdminFeedback() {
  const [rows, setRows] = useState<Row[]>([]);
  const [filter, setFilter] = useState<Filter>('new');
  const [loading, setLoading] = useState(true);
  const t = useToast();

  async function load(next: Filter = filter) {
    setLoading(true);
    try {
      const r = await api.admin.feedback(next === 'all' ? undefined : next);
      setRows(r.feedback);
    } catch (e) {
      t.err((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(filter);
    // load is stable enough here; refetching is driven by the filter alone.
  }, [filter]);

  async function setStatus(id: string, status: 'new' | 'read' | 'done') {
    try {
      await api.admin.setFeedbackStatus(id, status);
      // Drop it from the list when it no longer matches the active filter,
      // rather than leaving a row that contradicts the heading.
      setRows((prev) =>
        filter === 'all' ? prev.map((r) => (r.id === id ? { ...r, status } : r)) : prev.filter((r) => r.id !== id),
      );
    } catch (e) {
      t.err((e as Error).message);
    }
  }

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Sent from the button in the corner of the app. Anyone can send, signed in or not.
      </p>

      <Chips
        options={[
          { value: 'new' as Filter, label: 'New' },
          { value: 'read' as Filter, label: 'Read' },
          { value: 'done' as Filter, label: 'Done' },
          { value: 'all' as Filter, label: 'All' },
        ]}
        value={filter}
        onChange={setFilter}
      />
      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={4} />
      ) : rows.length === 0 ? (
        <Empty
          title={filter === 'new' ? 'Nothing new' : 'Nothing here'}
          hint="Messages sent through the feedback button show up here."
        />
      ) : (
        rows.map((r) => (
          <div className="card" key={r.id}>
            <div className="row between" style={{ gap: 10, marginBottom: 8 }}>
              <span className="badge watch">
                {FEEDBACK_KIND_LABEL[r.kind as FeedbackKind] ?? r.kind}
              </span>
              <span className="tiny dim">{r.created_at?.slice(0, 16).replace('T', ' ')}</span>
            </div>

            <p style={{ margin: '0 0 10px', fontSize: 14.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {r.message}
            </p>

            <p className="tiny dim" style={{ margin: '0 0 12px' }}>
              {r.user_name || r.user_email ? (
                <>
                  {r.user_name ?? 'Account'}
                  {r.user_email ? ` (${r.user_email})` : ''}
                </>
              ) : r.contact ? (
                <>Not signed in, left {r.contact}</>
              ) : (
                'Not signed in, no reply address'
              )}
              {r.path ? ` · from ${r.path}` : ''}
            </p>

            <div className="row" style={{ gap: 6 }}>
              {r.status !== 'read' && (
                <button className="btn ghost sm" type="button" onClick={() => setStatus(r.id, 'read')}>
                  Mark read
                </button>
              )}
              {r.status !== 'done' && (
                <button className="btn sm" type="button" onClick={() => setStatus(r.id, 'done')}>
                  Close
                </button>
              )}
              {r.status !== 'new' && (
                <button className="btn ghost sm" type="button" onClick={() => setStatus(r.id, 'new')}>
                  Reopen
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
}
