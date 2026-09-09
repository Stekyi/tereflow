import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { usePageTitle } from '../lib/pageTitle';
import { Empty, Skeletons, useToast } from '../components/ui';
import { INTENT_LABEL, type BusinessCard, type Rating } from '../../shared/types';

export default function CardDetail() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const t = useToast();

  const [card, setCard] = useState<BusinessCard | null>(null);
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [showRate, setShowRate] = useState(false);
  const [score, setScore] = useState(5);
  const [dealtIn, setDealtIn] = useState('');
  const [comment, setComment] = useState('');
  usePageTitle(card?.display_name);

  useEffect(() => {
    api.network
      .card(id)
      .then((r) => {
        setCard(r.card);
        setRatings(r.ratings);
      })
      .catch(() => setCard(null))
      .finally(() => setLoading(false));
    // Refetch when the viewer signs in. A card fetched while signed out comes
    // back without user_id, and messaging or rating needs it. Without this the
    // buttons would be there and would fail for somebody who signed in after
    // opening the page.
  }, [id, user?.id]);

  /**
   * The person behind this card, refetched if the card was loaded signed out.
   *
   * Returns null only when the card genuinely cannot be acted on, so callers
   * can say something true rather than sending an undefined id to the server.
   */
  async function subjectId(): Promise<string | null> {
    if (card?.user_id) return card.user_id;
    try {
      const r = await api.network.card(id);
      setCard(r.card);
      setRatings(r.ratings);
      return r.card?.user_id ?? null;
    } catch {
      return null;
    }
  }

  async function contact() {
    if (!user) return navigate(`/join?next=/network/${id}`);
    if (!card) return;
    if (!message.trim()) return t.err('Write a short message first');
    setSending(true);
    try {
      const to = await subjectId();
      if (!to) return t.err('That card cannot be messaged. Try reloading the page.');
      const r = await api.network.startConversation({
        to_user_id: to,
        body: message,
      });
      navigate(`/messages/${r.conversation_id}`);
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function submitRating() {
    if (!card) return;
    try {
      const subject = await subjectId();
      if (!subject) return t.err('That card cannot be rated. Try reloading the page.');
      await api.network.rate({
        subject_id: subject,
        score,
        dealt_in: dealtIn || undefined,
        comment: comment || undefined,
      });
      t.ok('Rating saved');
      setShowRate(false);
      const r = await api.network.card(id);
      setCard(r.card);
      setRatings(r.ratings);
    } catch (e) {
      t.err((e as Error).message);
    }
  }

  if (loading) return <Skeletons n={5} />;
  if (!card) return <Empty title="That card is not available" hint="It may be unpublished or removed." />;

  const isMe = user?.id === card.user_id;

  return (
    <>
      {t.node}

      <div className="row" style={{ gap: 12, marginBottom: 14 }}>
        <span className="flag" style={{ width: 44, height: 32, fontSize: 12 }}>
          {card.country_iso3}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 21, fontWeight: 750, letterSpacing: '-0.03em', lineHeight: 1.15 }}>
            {card.display_name}
          </div>
          <div className="tiny dim">
            {[card.company, card.city, card.country_iso3].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      {card.headline && (
        <div className="card tight">
          <div style={{ fontSize: 15, fontWeight: 600 }}>{card.headline}</div>
        </div>
      )}

      <div className="card">
        <p className="card-title">Here to</p>
        <div className="row wrap" style={{ gap: 6 }}>
          {card.intents.map((i) => (
            <span key={i} className="badge moderate">
              {INTENT_LABEL[i]}
            </span>
          ))}
        </div>

        {card.sectors.length > 0 && (
          <>
            <p className="card-title" style={{ marginTop: 16 }}>
              Sectors
            </p>
            <div className="row wrap" style={{ gap: 6 }}>
              {card.sectors.map((s) => (
                <span key={s} className="chip" style={{ cursor: 'default' }}>
                  {s}
                </span>
              ))}
            </div>
          </>
        )}

        {card.hs_codes.length > 0 && (
          <>
            <p className="card-title" style={{ marginTop: 16 }}>
              Products
            </p>
            <div className="row wrap" style={{ gap: 6 }}>
              {card.hs_codes.map((h) => (
                <span key={h} className="chip" style={{ cursor: 'default' }}>
                  {h}
                </span>
              ))}
            </div>
          </>
        )}

        {card.target_markets.length > 0 && (
          <>
            <p className="card-title" style={{ marginTop: 16 }}>
              Wants to reach
            </p>
            <div className="row wrap" style={{ gap: 6 }}>
              {card.target_markets.map((m) => (
                <span key={m} className="chip" style={{ cursor: 'default' }}>
                  {m}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {card.bio && (
        <div className="card">
          <p className="card-title">About</p>
          <p className="small muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
            {card.bio}
          </p>
        </div>
      )}

      {(card.website || card.whatsapp) && (
        <div className="card">
          <p className="card-title">Contact</p>
          {card.website && (
            <a className="src-link" href={card.website} target="_blank" rel="noreferrer noopener">
              <span className="u">{card.website}</span>
            </a>
          )}
          {card.whatsapp && (
            <a className="src-link" href={`https://wa.me/${card.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer noopener">
              <span className="u">WhatsApp {card.whatsapp}</span>
            </a>
          )}
        </div>
      )}

      {!isMe && (
        <div className="card">
          <p className="card-title">Send a message</p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Hi ${card.display_name.split(' ')[0]} — I can supply / I would like to buy…`}
          />
          <button
            className="btn primary block"
            onClick={contact}
            disabled={sending}
            style={{ marginTop: 10 }}
          >
            {sending ? 'Sending…' : user ? 'Send' : 'Join free to message'}
          </button>
        </div>
      )}

      <div className="card">
        <div className="row between" style={{ marginBottom: 10 }}>
          <p className="card-title" style={{ margin: 0 }}>
            Reputation
          </p>
          {card.rating_count > 0 ? (
            <span className="badge on">
              ★ {card.rating_avg.toFixed(1)} from {card.rating_count}
            </span>
          ) : (
            <span className="badge off">No ratings yet</span>
          )}
        </div>

        {ratings.map((r) => (
          <div key={r.id} className="bar-row" style={{ background: 'var(--bg-2)' }}>
            <div className="bar-content">
              <span className="rank-badge">{r.score}★</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                  {r.rater_name}
                  {r.dealt_in && <span className="dim"> · {r.dealt_in}</span>}
                </span>
                {r.comment && <span className="tiny dim">{r.comment}</span>}
              </span>
            </div>
          </div>
        ))}

        {!isMe && user && !showRate && (
          <button className="btn ghost block" onClick={() => setShowRate(true)} style={{ marginTop: 8 }}>
            Rate this person
          </button>
        )}

        {showRate && (
          <div style={{ marginTop: 12 }}>
            <div className="field">
              <label>Score</label>
              <div className="row" style={{ gap: 6 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`chip ${score === n ? 'active' : ''}`}
                    onClick={() => setScore(n)}
                  >
                    {n}★
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label htmlFor="di">What did you deal in?</label>
              <input id="di" value={dealtIn} onChange={(e) => setDealtIn(e.target.value)} placeholder="Shea butter, 2 containers" />
            </div>
            <div className="field">
              <label htmlFor="cm">Comment (optional)</label>
              <input id="cm" value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" onClick={submitRating} style={{ flex: 1 }}>
                Submit rating
              </button>
              <button className="btn ghost" onClick={() => setShowRate(false)}>
                Cancel
              </button>
            </div>
            <p className="tiny dim" style={{ marginTop: 8 }}>
              You can only rate someone you have messaged.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
