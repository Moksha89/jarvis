/**
 * Jarvis design tokens (master spec ss71). Fluent UI supplies colour and typography;
 * these tokens fix the 4px spacing grid, radii, motion and risk colour mapping so
 * every surface animates and breathes the same way.
 */
export const jarvisSpacing = {
  none: '0',
  xxs: '2px',
  xs: '4px',
  s: '8px',
  m: '12px',
  l: '16px',
  xl: '24px',
  xxl: '32px',
  xxxl: '48px',
} as const;

export const jarvisRadius = {
  none: '0',
  small: '4px',
  medium: '8px',
  large: '12px',
  pill: '999px',
} as const;

export const jarvisMotion = {
  /** Hover, focus and other micro-feedback. */
  fast: '100ms',
  /** Panels, expanding cards, navigation. */
  normal: '200ms',
  /** Page transitions and overlays. */
  slow: '300ms',
  easing: 'cubic-bezier(0.33, 0, 0.67, 1)',
} as const;

export const jarvisLayout = {
  sidebarExpandedWidth: '240px',
  sidebarCollapsedWidth: '52px',
  headerHeight: '48px',
  contentMaxWidth: '1120px',
} as const;

export type RiskAppearance = 'success' | 'informative' | 'warning' | 'danger' | 'severe';

/** Risk level to visual weight: 0 calm, 4 alarming. */
export const riskAppearance: Record<0 | 1 | 2 | 3 | 4, RiskAppearance> = {
  0: 'success',
  1: 'informative',
  2: 'warning',
  3: 'danger',
  4: 'severe',
};
