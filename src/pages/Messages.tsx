import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Empty, Skeletons } from '../components/ui';
import type { ConversationSummary } from '../../shared/types';

export default function Messages() {
  const { user, loading: sessionLoading } = useSession();
  const navigate = useNavigate();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionLoading && !user) navigate('/join?next=/messages', { replace: true });
  }, [sessionLoading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    api.network
      .conversations()
      .then((r) => setItems(r.conversations))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [user]);

  if (sessionLoading || loading) return <Skeletons n={5} />;

  if (items.length === 0)
    return (
      <Empty
        title="No conversations yet"
        hint="Find someone in the network and send them a message to start."
      />
    );

  return (
    <>
      {items.map((c) => (
        <Link className="list-item" key={c.id} to={`/messages/${c.id}`}>
          <span className="flag">{c.other_country ?? '??'}</span>
          <span className="grow">
            <span className="name">
              {c.other_name}
              {c.unread > 0 && (
                <span className="badge on" style={{ marginLeft: 8 }}>
                  {c.unread} new
                </span>
              )}
            </span>
            <span className="tiny dim">
              {c.last_message ? c.last_message.slice(0, 70) : 'No messages yet'}
            </span>
          </span>
          <span className="dim">›</span>
        </Link>
      ))}
    </>
  );
}
