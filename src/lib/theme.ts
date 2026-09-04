/**
 * Chart palette.
 *
 * Recharts needs concrete colour strings rather than CSS variables, so the
 * theme lives here in one place instead of being scattered through the chart
 * markup. Keep these in step with :root in styles/app.css.
 */
export const CHART = {
  brand: '#0a66c2',
  brandSoft: 'rgba(10, 102, 194, 0.22)',
  contrast: '#b24020',
  grid: '#e0dfdc',
  axis: 'rgba(0, 0, 0, 0.55)',
  tooltipBg: '#ffffff',
  tooltipBorder: '#d9d6d1',
  tooltipLabel: 'rgba(0, 0, 0, 0.6)',
} as const;
