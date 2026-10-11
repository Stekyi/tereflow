/**
 * Fades cards in as they scroll into view, on every page, from one place.
 *
 * Cards, list rows, figures and product rows are found by selector rather than marked up one by one, because they are
 * spread across every page and keep appearing as data loads. A MutationObserver picks up the ones added later.
 *
 * Each element is hidden only until it first meets the viewport. Afterwards the classes are removed again so the
 * element's own hover and layout styles are untouched. Nothing happens for reduced-motion users, or in a browser
 * without IntersectionObserver, so content is never left hidden.
 */
const SELECTOR = [
  'main .card',
  'main .list-item',
  'main .product-row',
  'main .stat',
  'main .bar-row',
  'main .mm-opp',
  'main .mm-card',
  'main .mm-news-card',
  'main .mm-stats',
].join(',');

export function startScrollReveal(): () => void {
  if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return () => undefined;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => undefined;

  const seen = new WeakSet<Element>();

  const io = new IntersectionObserver(
    (entries) => {
      let index = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target as HTMLElement;
        io.unobserve(el);
        // A short stagger for elements that arrive together, so a row of cards ripples in rather than popping.
        el.style.setProperty('--sr-delay', `${Math.min(index, 6) * 55}ms`);
        index += 1;
        el.classList.add('is-in');
        window.setTimeout(() => {
          el.classList.remove('sr', 'is-in');
          el.style.removeProperty('--sr-delay');
        }, 900);
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.04 },
  );

  const watch = (el: Element) => {
    if (seen.has(el)) return;
    seen.add(el);
    el.classList.add('sr');
    io.observe(el);
  };

  const scan = (root: ParentNode) => {
    if (root instanceof Element && root.matches(SELECTOR)) watch(root);
    root.querySelectorAll(SELECTOR).forEach(watch);
  };

  scan(document);
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n instanceof Element) scan(n);
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  return () => {
    io.disconnect();
    mo.disconnect();
    document.querySelectorAll('.sr').forEach((el) => el.classList.remove('sr', 'is-in'));
  };
}
