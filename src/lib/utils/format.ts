export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** Formats a number with a sensible amount of digits for tables. */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "–";
  const abs = Math.abs(value);
  const fraction = abs !== 0 && abs < 1 ? Math.max(digits, 3) : digits;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: fraction, minimumFractionDigits: 0 }).format(value);
}

export { ifcClassName, prettyCategory } from "./ifc-names";

export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "model";
}

export function baseName(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(0, index) : fileName;
}
