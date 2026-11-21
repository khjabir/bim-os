// Data colours for charts and for colouring groups in the 3D view.
//
// The eight categorical slots are used in this fixed order and never cycled:
// beyond eight groups the rest share the neutral "Other" colour. The same
// values are defined as CSS custom properties (--series-1 … --series-8) in
// globals.css; keep the two in sync.

const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const OTHER = { light: "#a3a8b1", dark: "#5d6572" };

export const SERIES_SLOTS = LIGHT.length;

export function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

/** Hex colour of a categorical slot (0-based); slots past the eighth return the "Other" colour. */
export function seriesColor(slot: number, dark = isDarkTheme()): string {
  if (slot < 0 || slot >= SERIES_SLOTS) return dark ? OTHER.dark : OTHER.light;
  return (dark ? DARK : LIGHT)[slot];
}

/** CSS variable reference for a slot, for use in styles so theme switches apply instantly. */
export function seriesVar(slot: number): string {
  return slot >= 0 && slot < SERIES_SLOTS ? `var(--series-${slot + 1})` : "var(--series-other)";
}
