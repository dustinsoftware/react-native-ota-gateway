/**
 * Minimal dark color palette and spacing scale for the demo app. The app is
 * always rendered in dark mode.
 */

const dark = {
  text: '#FFFFFF',
  background: '#222428',
  backgroundElement: '#2B2D31',
  backgroundSelected: '#2E3135',
  textSecondary: '#D9D9D9',
  textDisabled: '#686D78',
  /** Accent used for highlights and primary actions. */
  accent: '#FF6900',
} as const;

export const Colors = {
  light: dark,
  dark,
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;
