import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { helpForPath } from '../lib/help';
import { HelpBody, InfoIcon } from './InfoTip';

/** The floating (i) on every page. It explains the page being looked at, so a reader is never left guessing. */
export default function PageInfo() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const help = helpForPath(pathname);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!help || pathname.startsWith('/admin')) return null;

  return (
    <>
      <button type="button" className="fab fab-info" aria-label="About this page" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <InfoIcon />
      </button>
      {open && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <div className="modal info-sheet" role="dialog" aria-modal="true" aria-label={`About ${help.title}`} onMouseDown={(e) => e.stopPropagation()}>
            <div className="info-sheet-body">
              <HelpBody e={help} />
            </div>
            <button type="button" className="btn primary block" onClick={() => setOpen(false)}>
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
