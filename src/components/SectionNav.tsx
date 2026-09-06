import { useEffect, useRef, useState } from 'react';

export interface Section {
  id: string;
  label: string;
}

/**
 * In-page section switcher for a long scroll. It sticks under the app header,
 * highlights whichever section the reader is currently looking at, and jumps
 * smoothly to a section when tapped.
 *
 * The active state is driven by IntersectionObserver rather than scroll maths
 * so it stays correct regardless of section heights or viewport size.
 */
export default function SectionNav({ sections }: { sections: Section[] }) {
  const [active, setActive] = useState<string | null>(sections[0]?.id ?? null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (sections.length < 2) return;
    // The active section is the topmost one currently in view, so the highlight
    // follows the reader down the page instead of flickering between neighbours.
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const topmost = sections.find((s) => visible.has(s.id));
        if (topmost) setActive(topmost.id);
      },
      // Push the viewport's top edge below the sticky header and this nav, and
      // ignore the bottom half, so a section only becomes active once it has
      // risen into the reading zone.
      { rootMargin: '-120px 0px -55% 0px', threshold: 0 },
    );
    const nodes = sections
      .map((s) => document.getElementById(s.id))
      .filter((n): n is HTMLElement => n != null);
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [sections]);

  // Keep the highlighted chip within the horizontal scroller as it changes,
  // so on a narrow phone the active section is never off-screen.
  useEffect(() => {
    if (!active || !scrollerRef.current) return;
    const chip = scrollerRef.current.querySelector<HTMLElement>(`[data-id="${active}"]`);
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  if (sections.length < 2) return null;

  function jumpTo(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setActive(id);
    // Send focus to the section for keyboard and screen-reader users, without
    // letting the focus call fight the smooth scroll we just started.
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  }

  return (
    <nav className="section-nav" aria-label="Sections">
      <div className="scroll-x" ref={scrollerRef}>
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            data-id={s.id}
            className={`chip${active === s.id ? ' active' : ''}`}
            aria-current={active === s.id ? 'true' : undefined}
            onClick={(event) => jumpTo(event, s.id)}
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
