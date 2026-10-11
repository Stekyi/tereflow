import { useEffect, useRef, useState } from 'react';

/**
 * A short looping scene for the home page, in three beats over 21 seconds:
 * a ship and its captain at sea, the scale weighing exports against imports,
 * then a contract being signed while bars grow and countries light up.
 *
 * Pure SVG and CSS keyframes, so it costs no video download and sits still for
 * anyone who has asked their system for reduced motion.
 */
export function TradeStory({ className }: { className?: string }) {
  return (
    <svg
      className={`mm-story ${className ?? ''}`}
      viewBox="0 0 400 260"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="A ship at sea, the scale of trade, and a contract being signed as countries light up"
    >
      <defs>
        <linearGradient id="ts-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0e2438" />
          <stop offset="55%" stopColor="#2a5a7c" />
          <stop offset="100%" stopColor="#d59a3c" />
        </linearGradient>
        <linearGradient id="ts-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#16405c" />
          <stop offset="100%" stopColor="#08202f" />
        </linearGradient>
        <linearGradient id="ts-night" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0b1f33" />
          <stop offset="100%" stopColor="#0d3b2c" />
        </linearGradient>
        <clipPath id="ts-clip">
          <rect width="400" height="260" rx="22" />
        </clipPath>
      </defs>

      <g clipPath="url(#ts-clip)">
        <rect width="400" height="260" fill="#071826" />

        {/* Beat 1: the ship and the captain */}
        <g className="sc sc1">
          <rect width="400" height="260" fill="url(#ts-sky)" />
          <circle className="sun" cx="290" cy="150" r="26" fill="#f0c274" />
          <rect y="150" width="400" height="110" fill="url(#ts-sea)" />
          <g className="waves" fill="none" stroke="#e2eaf1" strokeLinecap="round">
            <path d="M0 176q20-9 40 0t40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0" strokeWidth="1.4" opacity=".35" />
            <path d="M-20 204q20-9 40 0t40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0" strokeWidth="1.8" opacity=".3" />
            <path d="M-8 232q20-9 40 0t40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0 40 0" strokeWidth="2.2" opacity=".25" />
          </g>
          <g className="ship">
            <g className="bob">
              <path d="M36 152 L214 152 L192 180 L62 180 Z" fill="#061019" />
              <rect x="112" y="70" width="4" height="82" fill="#061019" />
              <path d="M117 76 L117 142 L176 142 Z" fill="#e2eaf1" opacity=".92" />
              <path d="M111 84 L111 142 L58 142 Z" fill="#e2eaf1" opacity=".85" />
              <path d="M114 70 L132 76 L114 82 Z" fill="#34c77b" />
              {/* the captain, at the bow, watching the horizon */}
              <g className="captain">
                <rect x="192" y="128" width="9" height="24" rx="3" fill="#0b2a1e" />
                <circle cx="196.5" cy="123" r="5.5" fill="#d9a066" />
                <path d="M189 120 h15 l-2 -6 h-11 z" fill="#0b2a1e" />
                <rect x="187" y="119.5" width="19" height="2.4" rx="1" fill="#0b2a1e" />
                <line className="glass" x1="200" y1="134" x2="222" y2="124" stroke="#d59a3c" strokeWidth="3.2" strokeLinecap="round" />
              </g>
            </g>
          </g>
          <text x="200" y="246" textAnchor="middle" className="cap">Goods on the move</text>
        </g>

        {/* Beat 2: the scale of trade */}
        <g className="sc sc2">
          <rect width="400" height="260" fill="url(#ts-night)" />
          <rect x="197" y="86" width="6" height="118" rx="3" fill="#e2eaf1" />
          <path d="M160 206 h80 l-10 -14 h-60 z" fill="#e2eaf1" opacity=".9" />
          <circle cx="200" cy="86" r="8" fill="#d59a3c" />
          <g className="beam">
            <rect x="82" y="83" width="236" height="6" rx="3" fill="#e2eaf1" />
          </g>
          <g className="pan panL">
            <path d="M92 89 L72 148 M92 89 L112 148" stroke="#e2eaf1" strokeWidth="1.5" />
            <path d="M62 148 h60 a30 16 0 0 1 -60 0 z" fill="#e2eaf1" opacity=".9" />
            <rect x="74" y="124" width="18" height="22" rx="2" fill="#c98b3a" />
            <rect x="94" y="130" width="16" height="16" rx="2" fill="#a8702a" />
            <text x="92" y="176" textAnchor="middle" className="lab">EXPORTS</text>
          </g>
          <g className="pan panR">
            <path d="M308 89 L288 148 M308 89 L328 148" stroke="#e2eaf1" strokeWidth="1.5" />
            <path d="M278 148 h60 a30 16 0 0 1 -60 0 z" fill="#e2eaf1" opacity=".9" />
            <circle cx="296" cy="140" r="8" fill="#34c77b" />
            <circle cx="312" cy="140" r="8" fill="#2fb36d" />
            <circle cx="304" cy="127" r="8" fill="#34c77b" />
            <text x="308" y="176" textAnchor="middle" className="lab">IMPORTS</text>
          </g>
          <text x="200" y="246" textAnchor="middle" className="cap">Weighing what moves each way</text>
        </g>

        {/* Beat 3: the contract, the growth, the countries */}
        <g className="sc sc3">
          <rect width="400" height="260" fill="url(#ts-night)" />
          <g>
            <rect x="34" y="34" width="148" height="176" rx="8" fill="#f7f8fb" />
            <rect x="50" y="52" width="70" height="7" rx="3" fill="#16283b" />
            <rect x="50" y="72" width="116" height="4" rx="2" fill="#c3cad6" />
            <rect x="50" y="84" width="104" height="4" rx="2" fill="#c3cad6" />
            <rect x="50" y="96" width="112" height="4" rx="2" fill="#c3cad6" />
            <rect x="50" y="108" width="84" height="4" rx="2" fill="#c3cad6" />
            <path className="sign" d="M52 176 q10 -26 20 -4 t18 0 q8 -22 18 2 t20 -6" fill="none" stroke="#0f9d58" strokeWidth="3" strokeLinecap="round" pathLength="100" />
            <line x1="50" y1="184" x2="166" y2="184" stroke="#8a94a2" strokeWidth="1" />
            <g className="seal">
              <circle cx="152" cy="150" r="17" fill="#0f9d58" />
              <path d="M143 150 l7 7 l12 -14" fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </g>
          <g transform="translate(206 0)">
            <line x1="14" y1="196" x2="186" y2="196" stroke="#4b6a85" strokeWidth="1.2" />
            <rect className="bar b1" x="22" y="150" width="26" height="46" rx="3" fill="#34c77b" />
            <rect className="bar b2" x="62" y="128" width="26" height="68" rx="3" fill="#2fb36d" />
            <rect className="bar b3" x="102" y="104" width="26" height="92" rx="3" fill="#34c77b" />
            <rect className="bar b4" x="142" y="72" width="26" height="124" rx="3" fill="#0f9d58" />
            <path className="trend" d="M35 138 L75 114 L115 92 L155 58" fill="none" stroke="#f0c274" strokeWidth="3" strokeLinecap="round" pathLength="100" />
            <g className="dots">
              <circle className="d d1" cx="28" cy="40" r="5" fill="#34c77b" />
              <circle className="d d2" cx="70" cy="28" r="5" fill="#34c77b" />
              <circle className="d d3" cx="112" cy="44" r="5" fill="#34c77b" />
              <circle className="d d4" cx="152" cy="26" r="5" fill="#34c77b" />
              <path className="route" d="M28 40 L70 28 L112 44 L152 26" fill="none" stroke="#34c77b" strokeWidth="1.2" strokeDasharray="3 4" opacity=".7" />
            </g>
          </g>
          <text x="200" y="246" textAnchor="middle" className="cap">Contracts signed, markets lit</text>
        </g>
      </g>
    </svg>
  );
}

/**
 * A figure that counts up to its value the first time it scrolls into view.
 *
 * Takes the formatted text ("$554.87B", "21,500", "-$394.00B"), animates the
 * number inside it and leaves the currency, sign and suffix alone. Anything
 * without a number in it, and anyone who prefers reduced motion, gets the text
 * as it is.
 */
const FIGURE = /^([^0-9]*?)([\d,]+(?:\.\d+)?)(.*)$/;

export function CountUp({ text, ms = 1100 }: { text: string; ms?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const match = FIGURE.exec(text);
  const [shown, setShown] = useState<string>(text);

  useEffect(() => {
    setShown(text);
    const el = ref.current;
    if (!el || !match) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const [, prefix, numText, suffix] = match;
    const target = parseFloat(numText.replace(/,/g, ''));
    if (!Number.isFinite(target) || target === 0) return;
    const decimals = (numText.split('.')[1] ?? '').length;
    const grouped = numText.includes(',');
    const fmt = (v: number) =>
      v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped });
    let raf = 0;
    setShown(`${prefix}${fmt(0)}${suffix}`);
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / ms);
          const eased = 1 - Math.pow(1 - t, 3);
          setShown(`${prefix}${fmt(target * eased)}${suffix}`);
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, ms]);

  return <span ref={ref}>{shown}</span>;
}
