import { createContext, useContext, useEffect } from 'react';

type SetPageTitle = (title: string | null) => void;

// Detail pages fetch their own data, so only they know the real entity name.
// They report it here and the top bar reads it, which keeps App free of any
// per-entity fetching just to render a heading.
export const PageTitleContext = createContext<SetPageTitle>(() => {});

// Report the current page's real name (country, person, playbook) to the top
// bar. Passing a falsy value while data is still loading leaves the route-based
// fallback in place instead of flashing an empty heading.
export function usePageTitle(title: string | null | undefined): void {
  const setTitle = useContext(PageTitleContext);
  useEffect(() => {
    if (!title) return;
    setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);
}
