/**
 * Chart palette.
 *
 * Recharts needs concrete colour strings rather than CSS variables, so the
 * theme lives here in one place instead of being scattered through the chart
 * markup. Keep these in step with :root in styles/app.css.
 */
export const CHART = {
  brand: '#0b3d67',
  brandSoft: 'rgba(11, 61, 103, 0.2)',
  contrast: '#a8802c',
  grid: '#e8e2d6',
  axis: '#8a94a2',
  tooltipBg: '#ffffff',
  tooltipBorder: '#ddd6c8',
  tooltipLabel: '#556273',
} as const;
