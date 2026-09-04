import { useEffect, useState, type ReactNode } from 'react';

export function Toast({ msg, kind }: { msg: string; kind: 'ok' | 'err' }) {
  if (!msg) return null;
  return <div className={`toast ${kind}`}>{msg}</div>;
}

/** Tiny toast controller so pages do not each reinvent it. */
export function useToast() {
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' }>({ msg: '', kind: 'ok' });
  useEffect(() => {
    if (!toast.msg) return;
    const t = setTimeout(() => setToast({ msg: '', kind: 'ok' }), 3200);
    return () => clearTimeout(t);
  }, [toast]);
  return {
    toast,
    ok: (msg: string) => setToast({ msg, kind: 'ok' }),
    err: (msg: string) => setToast({ msg, kind: 'err' }),
    node: <Toast msg={toast.msg} kind={toast.kind} />,
  };
}

export function Skeletons({ n = 4 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div style={{ fontSize: 34, marginBottom: 10, opacity: 0.4 }}>◍</div>
      <div style={{ fontWeight: 650, color: 'var(--muted)' }}>{title}</div>
      {hint && (
        <div className="small" style={{ marginTop: 6, maxWidth: 380, marginInline: 'auto' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track">
        <span className="thumb" />
      </span>
      {label && <span className="small">{label}</span>}
    </label>
  );
}

export function Stat({
  label,
  value,
  delta,
  deltaTone,
}: {
  label: string;
  value: string;
  delta?: string | null;
  deltaTone?: 'up' | 'down' | null;
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && <div className={`delta ${deltaTone ?? 'dim'}`}>{delta}</div>}
    </div>
  );
}

/** Horizontal bar row used for every ranked list. */
export function BarRow({
  rank,
  name,
  value,
  share,
  max,
  meta,
  action,
}: {
  rank: number;
  name: string;
  value: string;
  share: number;
  max: number;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  const pct = max > 0 ? Math.max(2, (share / max) * 100) : 0;
  return (
    <div className="bar-row">
      <div className="bar-fill" style={{ width: `${pct}%` }} />
      <div className="bar-content">
        <span className="rank-badge">{rank}</span>
        <span className="grow" style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontWeight: 620,
              fontSize: 14,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {name}
          </span>
          {meta && <span className="tiny dim">{meta}</span>}
        </span>
        <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap' }}>{value}</span>
        {action}
      </div>
    </div>
  );
}

/**
 * Follow toggle. Following is free on purpose — a watchlist is what makes the
 * premium feed worth paying for, so there is no sense gating the act itself.
 */
export function FollowButton({
  kind,
  value,
  label,
  following,
  onChange,
}: {
  kind: 'product' | 'sector' | 'country' | 'hs_code';
  value: string;
  label: string;
  following: boolean;
  onChange: (following: boolean, kind: string, value: string, label: string) => void;
}) {
  return (
    <button
      className={`chip ${following ? 'active' : ''}`}
      style={{ flex: 'none' }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onChange(!following, kind, value, label);
      }}
      title={following ? 'Unfollow' : 'Follow for weekly analysis'}
    >
      {following ? '★' : '☆'}
    </button>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="scroll-x">
      {options.map((o) => (
        <button
          key={o.value}
          className={`chip ${value === o.value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
