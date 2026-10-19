import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { TIPS, type HelpEntry } from '../lib/help';

function Body({ e }: { e: HelpEntry }) {
  return (
    <>
      <span className="term-pop-title">{e.title}</span>
      <span className="term-pop-body">{e.what}</span>
      <span className="term-pop-block">
        <span className="term-pop-label">How it helps you</span>
        {e.helps}
      </span>
      {e.read && (
        <span className="term-pop-block">
          <span className="term-pop-label">How to read it</span>
          {e.read}
        </span>
      )}
      <span className="term-pop-block">
        <span className="term-pop-label">What next</span>
        {e.next}
      </span>
    </>
  );
}

export const InfoIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 11v6M12 7.2v.1" />
  </svg>
);

/**
 * A small (i) beside a heading, tab or chart. Tapping it opens a short panel that says what the
 * thing is, how it helps find or check a trade, how to read it, and what to do next.
 */
export default function InfoTip({ k, label }: { k: string; label?: string }) {
  const entry = TIPS[k];
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(320, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, r.left - 8), window.innerWidth - width - margin);
    const estimated = 300;
    const below = window.innerHeight - r.bottom;
    const top = below < estimated && r.top > estimated ? r.top - estimated - 8 : r.bottom + 8;
    setPos({ left, top });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (ev: MouseEvent) => {
      if (!wrap.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  if (!entry) return null;

  return (
    <span className="info-wrap" ref={wrap}>
      <button
        type="button"
        className="info-btn"
        aria-label={label ?? `About ${entry.title}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <InfoIcon />
      </button>
      {open && pos && (
        <span className="term-pop info-pop" id={id} role="note" style={{ left: pos.left, top: pos.top, width: Math.min(320, window.innerWidth - 24) }}>
          <Body e={entry} />
        </span>
      )}
    </span>
  );
}

export { Body as HelpBody };
