import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { useToast } from './ui';
import { FEEDBACK_KIND_LABEL, type FeedbackKind } from '../../shared/types';

const KINDS: FeedbackKind[] = ['problem', 'request', 'other'];

/**
 * Floating feedback button.
 *
 * Deliberately reachable without an account. Asking somebody to register
 * before they can tell you a page is broken is how you stop being told that
 * pages are broken. The route they were on is sent with the message so nobody
 * has to reconstruct where they were.
 */
export default function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>('problem');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [sending, setSending] = useState(false);
  const { pathname } = useLocation();
  const { user } = useSession();
  const t = useToast();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function send() {
    const text = message.trim();
    if (text.length < 4) {
      t.err('Tell us a little more than that');
      return;
    }
    setSending(true);
    try {
      await api.sendFeedback({
        kind,
        message: text,
        path: pathname,
        contact: user ? undefined : contact.trim() || undefined,
      });
      t.ok('Thanks. That went through.');
      setMessage('');
      setContact('');
      setOpen(false);
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="fab"
        onClick={() => setOpen(true)}
        aria-label="Send feedback or request a feature"
        title="Feedback and requests"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden>
          <path
            d="M21 6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l5-4h6a2 2 0 0 0 2-2z"
            strokeLinejoin="round"
          />
          <path d="M12 8v3.5" strokeLinecap="round" />
          <circle cx="12" cy="14" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>

      {open && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="row between" style={{ gap: 12 }}>
              <div>
                <p className="overline" style={{ margin: 0 }}>
                  Feedback
                </p>
                <h2 id="feedback-title" style={{ margin: '3px 0 0', fontSize: 22 }}>
                  Tell us what to fix
                </h2>
              </div>
              <button
                className="icon-btn"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                {'\u00d7'}
              </button>
            </div>

            <div className="row wrap" style={{ gap: 6, margin: '14px 0 12px' }}>
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`chip${kind === k ? ' on' : ''}`}
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                >
                  {FEEDBACK_KIND_LABEL[k]}
                </button>
              ))}
            </div>

            <div className="field">
              <label htmlFor="feedback-message">Your message</label>
              <textarea
                id="feedback-message"
                rows={5}
                value={message}
                maxLength={2000}
                placeholder={
                  kind === 'request'
                    ? 'What would you want the app to do?'
                    : kind === 'problem'
                      ? 'What went wrong, and what were you trying to do?'
                      : 'Anything you want to say.'
                }
                onChange={(e) => setMessage(e.target.value)}
              />
              <span className="help">
                We record the page you are on ({pathname}) so nobody has to ask.
              </span>
            </div>

            {!user && (
              <div className="field">
                <label htmlFor="feedback-contact">Email, if you want a reply</label>
                <input
                  id="feedback-contact"
                  type="email"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            )}

            <button
              className="btn primary block"
              type="button"
              onClick={send}
              disabled={sending || message.trim().length < 4}
            >
              {sending ? 'Sending' : 'Send'}
            </button>
          </section>
        </div>
      )}
    </>
  );
}
