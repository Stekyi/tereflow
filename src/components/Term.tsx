import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY } from '../lib/glossary';

/**
 * A term of art that explains itself.
 *
 * Renders as underlined text. Tapping it opens a small panel with a plain
 * English definition, why it matters, and how to read the number next to it.
 * Built as a button rather than an anchor because it goes nowhere, which also
 * gives keyboard and screen reader behaviour for free.
 */
export function Term({
  k,
  children,
  tone = 'default',
}: {
  k: keyof typeof GLOSSARY | string;
  children?: ReactNode;
  tone?: 'default' | 'gold' | 'quiet';
}) {
  const entry = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  /**
   * The panel is fixed-position and clamped to the viewport.
   *
   * Anchoring it to the term's parent cannot work: terms sit inside narrow
   * grid cells, so a left-anchored panel overflows right and a right-anchored
   * one overflows left. Measuring and clamping handles every position.
   */
  const place = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(300, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(margin, r.left), window.innerWidth - width - margin);

    // Flip above the term when there is not enough room below it.
    const estimated = 210;
    const below = window.innerHeight - r.bottom;
    const top = below < estimated && r.top > estimated ? r.top - estimated - 8 : r.bottom + 8;

    setPos({ left, top });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Follow the term on scroll and resize rather than closing. Closing races
    // with the browser's own scroll-into-view when a term is tapped near the
    // fold, which made the panel vanish the instant it appeared.
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

  // Unknown key: render the text plainly rather than a dead link.
  if (!entry) return <>{children ?? k}</>;

  return (
    <span className="term-wrap" ref={wrap}>
      <button
        type="button"
        className={`term term-${tone}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {children ?? entry.term}
      </button>

      {open && pos && (
        <span
          className="term-pop"
          id={id}
          role="note"
          style={{ left: pos.left, top: pos.top }}
        >
          <span className="term-pop-title">{entry.term}</span>
          <span className="term-pop-body">{entry.what}</span>
          {entry.why && (
            <span className="term-pop-block">
              <span className="term-pop-label">Why it matters</span>
              {entry.why}
            </span>
          )}
          {entry.read && (
            <span className="term-pop-block">
              <span className="term-pop-label">How to read it</span>
              {entry.read}
            </span>
          )}
          {entry.source && (
            <a
              className="term-pop-src"
              href={entry.source.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
            >
              {entry.source.label} ↗
            </a>
          )}
        </span>
      )}
    </span>
  );
}
