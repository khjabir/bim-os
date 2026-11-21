// Light and dark theme: a class on <html>, remembered in this browser. The
// layout's inline script applies the saved theme before the first paint.

import { create } from "zustand";

const KEY = "ifc-studio-theme";

export const useTheme = create<{ dark: boolean }>(() => ({ dark: false }));

/** Reads the theme the page started with (after hydration). */
export function syncTheme() {
  useTheme.setState({ dark: document.documentElement.classList.contains("dark") });
}

export function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  useTheme.setState({ dark });
  try {
    localStorage.setItem(KEY, dark ? "dark" : "light");
  } catch {
    /* storage unavailable */
  }
}

export function toggleTheme() {
  setTheme(!document.documentElement.classList.contains("dark"));
}
