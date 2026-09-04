import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Skeletons, useToast } from '../components/ui';
import type { Message } from '../../shared/types';

export default function Thread() {
  const { id = '' } = useParams();
  const { refresh } = useSession();
  const t = useToast();
  const [messages, setMessages] = useState<Message[]>([]);
  const [other, setOther] = useState<{ id: string; name: string; company: string | null } | null>(
    null,
  );
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  async function load(scroll = false) {
    try {
      const r = await api.network.messages(id);
      setMessages(r.messages);
      setOther(r.other);
      if (scroll) setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), 60);
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true).then(() => refresh());
    const poll = setInterval(() => void load(), 20_000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setDraft('');
    try {
      const r = await api.network.send(id, body);
      setMessages((m) => [...m, { ...r.message, read_at: null, created_at: new Date().toISOString() }]);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), 40);
    } catch (e) {
      t.err((e as Error).message);
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  if (loading) return <Skeletons n={4} />;

  return (
    <>
      {t.node}

      {other && (
        <div className="card tight" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 650 }}>{other.name}</div>
          {other.company && <div className="tiny dim">{other.company}</div>}
        </div>
      )}

      <div className="thread">
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.mine ? 'mine' : 'theirs'}`}>
            {m.body}
            <span className="stamp">
              {new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <div className="composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a message"
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" onClick={send} disabled={sending || !draft.trim()}>
          Send
        </button>
      </div>
    </>
  );
}
