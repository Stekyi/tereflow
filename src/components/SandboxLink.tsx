import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { buildSandboxPath, signInThenPath, type SandboxLinkInput } from '../../shared/sandbox-link';

/**
 * Opens Trade Sandbox on one country, partner, product and flow. Signed-out
 * readers are sent through sign-in first and returned to the same link, so the
 * action is only ever used by a signed-in user. Renders nothing when the
 * inputs cannot form a valid link.
 */
export default function SandboxLink({
  className = 'link-btn',
  children = 'Open in Sandbox',
  ...input
}: SandboxLinkInput & { className?: string; children?: React.ReactNode }) {
  const { user } = useSession();
  const target = buildSandboxPath(input);
  if (!target) return null;
  return (
    <Link
      className={className}
      to={user ? target : signInThenPath(target)}
      onClick={(e) => e.stopPropagation()}
      title={user ? 'Compare this partner in Trade Sandbox' : 'Sign in to open Trade Sandbox'}
    >
      {children}
    </Link>
  );
}
