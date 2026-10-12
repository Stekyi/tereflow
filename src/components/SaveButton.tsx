import { useState } from 'react';
import { useSession } from '../lib/auth';
import { social } from '../lib/api-social';

/**
 * Saves one country, partner, product and flow to the signed-in user's private
 * shortlist. Signed-out readers see nothing; the Sandbox link beside it already
 * carries them through sign-in.
 */
export default function SaveButton({
  countrySlug, partnerIso3, hs, flow, title,
}: { countrySlug?: string | null; partnerIso3?: string | null; hs?: string | null; flow?: string | null; title: string }) {
  const { user } = useSession();
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'error'>('idle');
  if (!user || !countrySlug) return null;
  async function save(e: React.MouseEvent) {
    e.stopPropagation();
    setState('busy');
    try {
      await social.save({ country_slug: countrySlug!, partner_iso3: partnerIso3 ?? '', hs_code: hs ?? '', flow: flow ?? '', title });
      setState('saved');
    } catch (err) {
      // Already saved is a success from the reader's point of view.
      setState((err as { status?: number }).status === 409 ? 'saved' : 'error');
    }
  }
  return (
    <button type="button" className="link-btn" disabled={state === 'busy' || state === 'saved'} onClick={save}
      title="Save to your private shortlist" style={{ marginLeft: 8 }}>
      {state === 'saved' ? 'Saved' : state === 'error' ? 'Retry save' : 'Save'}
    </button>
  );
}
