/**
 * Brand artwork.
 *
 * Both marks are drawn here rather than shipped as image files so they inherit
 * the theme colours, stay sharp at any size, and cost no extra request.
 */

/**
 * The Tereflow mark: a pair of binoculars, taken from the two-barrel sketch
 * with the bridge across the middle.
 *
 * Drawn head-on rather than in perspective so it still reads at 20px in the
 * top bar, which is the size it is used at most.
 */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}

      {/* Bridge. Sits behind the barrels so the joins are hidden. */}
      <rect x="15.5" y="18" width="9" height="4.4" rx="1.4" fill="currentColor" opacity="0.55" />

      {/* Left barrel: eyepiece, body, objective lens. */}
      <path
        d="M6.4 14.2c0-1.6 1.2-2.8 2.8-2.8h4.2c1.6 0 2.8 1.2 2.8 2.8v10.9c0 3.1-2.4 5.6-5.4 5.6s-5.4-2.5-5.4-5.6z"
        fill="currentColor"
      />
      <circle cx="10.8" cy="24.4" r="2.7" fill="var(--gold, #a8802c)" />

      {/* Right barrel, mirrored. */}
      <path
        d="M23.8 14.2c0-1.6 1.2-2.8 2.8-2.8h4.2c1.6 0 2.8 1.2 2.8 2.8v10.9c0 3.1-2.4 5.6-5.4 5.6s-5.4-2.5-5.4-5.6z"
        fill="currentColor"
      />
      <circle cx="28.2" cy="24.4" r="2.7" fill="var(--gold, #a8802c)" />

      {/* Focus wheel on the bridge. */}
      <rect x="18.4" y="16.4" width="3.2" height="7.6" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/**
 * Home banner: a ship on the horizon, framed by the twin circles of a pair of
 * binoculars, with the reticle you would see looking through them.
 *
 * Original artwork. Kept to silhouettes and flat fills so it stays legible on
 * a phone and does not fight the type sitting on top of it.
 */
export function HeroScene({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 300 200"
      // Anchored and scaled by height rather than stretched to fill. The hero
      // is a short wide band, so slicing a landscape composition into it
      // cropped the ship away and left only sky.
      preserveAspectRatio="xMidYMid meet"
      role="presentation"
      aria-hidden
    >
      <defs>
        {/* Everything is clipped to the binocular field of view, which is what
            makes it read as "seen through" rather than "next to". */}
        <clipPath id="tf-field">
          <circle cx="100" cy="100" r="66" />
          <circle cx="200" cy="100" r="66" />
        </clipPath>

        <linearGradient id="tf-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0e2438" />
          <stop offset="52%" stopColor="#2a5a7c" />
          <stop offset="100%" stopColor="#d59a3c" />
        </linearGradient>

        <linearGradient id="tf-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#16405c" />
          <stop offset="100%" stopColor="#08202f" />
        </linearGradient>
      </defs>

      <g clipPath="url(#tf-field)">
        <rect width="300" height="200" fill="url(#tf-sky)" />

        {/* Sun low on the horizon, behind the ship. */}
        <circle cx="196" cy="118" r="22" fill="#f0c274" opacity="0.9" />

        <rect y="118" width="300" height="82" fill="url(#tf-sea)" />

        {/* Sun track on the water. */}
        <g fill="#f0c274" opacity="0.42">
          <rect x="186" y="124" width="20" height="2.2" rx="1.1" />
          <rect x="179" y="132" width="34" height="2" rx="1" />
          <rect x="172" y="141" width="48" height="1.8" rx="0.9" />
          <rect x="164" y="151" width="64" height="1.6" rx="0.8" />
          <rect x="156" y="162" width="80" height="1.5" rx="0.75" />
        </g>

        {/* Tall ship, sitting in the left barrel. Three masts, square rigged. */}
        <g transform="translate(96 118) scale(0.78)" fill="#061019">
          {/* Hull. */}
          <path d="M-46 0h92l-11 15a6 6 0 0 1-4.6 2.2H-30.4A6 6 0 0 1-35 15z" />
          {/* Bowsprit. */}
          <path d="M44 -2l22 -9 1.6 3.4-21 9.6z" />

          {/* Masts. */}
          <rect x="-25" y="-64" width="3" height="64" />
          <rect x="-2" y="-84" width="3.4" height="84" />
          <rect x="22" y="-58" width="3" height="58" />

          {/* Yards. */}
          <g fill="#061019">
            <rect x="-40" y="-61" width="17" height="1.8" />
            <rect x="-43" y="-40" width="20" height="1.8" />
            <rect x="-18" y="-79" width="18" height="1.8" />
            <rect x="-21" y="-56" width="21" height="1.8" />
            <rect x="9" y="-55" width="16" height="1.8" />
          </g>

          {/* Sails. */}
          <path d="M-38 -59h13v17h-13z" opacity="0.94" />
          <path d="M-41 -38h16v18h-16z" opacity="0.94" />
          <path d="M-16 -77h16v19h-16z" opacity="0.97" />
          <path d="M-19 -54h19v21h-19z" opacity="0.97" />
          <path d="M-22 -29h22v22h-22z" opacity="0.97" />
          <path d="M11 -53h13v16H11z" opacity="0.92" />
          <path d="M9 -33h15v18H9z" opacity="0.92" />
          {/* Jib, forward of the foremast. */}
          <path d="M28 -45 60 -9H28z" opacity="0.9" />
        </g>

        {/* Reticle in the right barrel only, the way a real pair marks one side. */}
        <g stroke="#e2eaf1" strokeWidth="0.9" opacity="0.34">
          <line x1="200" y1="42" x2="200" y2="158" />
          <line x1="142" y1="100" x2="258" y2="100" />
        </g>
        <g stroke="#e2eaf1" strokeWidth="1.3" opacity="0.42">
          <line x1="193" y1="84" x2="207" y2="84" />
          <line x1="195" y1="70" x2="205" y2="70" />
          <line x1="193" y1="116" x2="207" y2="116" />
          <line x1="195" y1="130" x2="205" y2="130" />
        </g>

        {/* Vignette so the edge of the field falls away. */}
        <circle cx="100" cy="100" r="66" fill="none" stroke="#04101a" strokeWidth="13" opacity="0.5" />
        <circle cx="200" cy="100" r="66" fill="none" stroke="#04101a" strokeWidth="13" opacity="0.5" />
      </g>

      {/* Barrel rims and the bridge between them. */}
      <rect x="128" y="92" width="44" height="16" rx="5" fill="#04101a" opacity="0.9" />
      <circle cx="100" cy="100" r="66" fill="none" stroke="#04101a" strokeWidth="5" />
      <circle cx="200" cy="100" r="66" fill="none" stroke="#04101a" strokeWidth="5" />
      <circle cx="100" cy="100" r="62.5" fill="none" stroke="#a8802c" strokeWidth="1.5" opacity="0.6" />
      <circle cx="200" cy="100" r="62.5" fill="none" stroke="#a8802c" strokeWidth="1.5" opacity="0.6" />
    </svg>
  );
}
