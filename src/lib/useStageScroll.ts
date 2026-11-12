import { useEffect, useRef } from 'react';

/** When the stage changes, bring the stage tabs back into view so the reader sees the new stage, not the middle of the old one. */
export function useStageScroll(stage: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    document.querySelector('.stage-steps')?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [stage]);
}
