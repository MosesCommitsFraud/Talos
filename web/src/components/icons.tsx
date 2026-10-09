import type { SVGProps } from 'react';

/* Talos' own glyphs for the two work panes, drawn on lucide's 24px grid with
 * the same stroke so they sit beside lucide icons, but shaped after what the
 * panes show rather than a generic checklist or robot. */

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** Plan: a route of milestones — the first one reached (filled), the path
 *  running down to the ones still ahead, each with its line of text. */
export function PlanIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="5.5" cy="5" r="2.5" fill="currentColor" />
      <circle cx="5.5" cy="12" r="2" />
      <circle cx="5.5" cy="19" r="2" />
      <path d="M5.5 7.5v2.5M5.5 14v3" />
      <path d="M11 5h9M11 12h7M11 19h5" />
    </svg>
  );
}

/** Agents: three helpers circling the main agent — the orbit is broken where
 *  each one sits, so they read as separate bodies, not beads on a ring. */
export function AgentsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      {/* Orbit r=8.5 split into three arcs between the helpers (at -90°, 30°, 150°). */}
      <path d="M15.1 4.1A8.5 8.5 0 0 1 20.4 13.3M17.3 18.9A8.5 8.5 0 0 1 6.7 18.9M3.6 13.3A8.5 8.5 0 0 1 8.9 4.1" />
      <circle cx="12" cy="3.5" r="2" fill="currentColor" />
      <circle cx="19.4" cy="16.25" r="2" fill="currentColor" />
      <circle cx="4.6" cy="16.25" r="2" fill="currentColor" />
    </svg>
  );
}
