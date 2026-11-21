// Loads the Autodesk viewer ("LMV") script and stylesheet from Autodesk's CDN.
// The viewer is Autodesk's own, proprietary software: it is not bundled with
// this app and is only fetched when the NWD page opens a model.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The viewer has no public type package; these aliases mark where its objects travel. */
export type LmvNamespace = any;
export type LmvViewer = any;
export type LmvModel = any;
export type LmvTree = any;

const BASE = "https://developer.api.autodesk.com/modelderivative/v2/viewers";

// Autodesk documents both spellings of the versioned address; try one, then the other.
const SOURCES = [
  { script: `${BASE}/viewer3D.min.js?v=v7.*`, style: `${BASE}/style.min.css?v=v7.*` },
  { script: `${BASE}/7.*/viewer3D.min.js`, style: `${BASE}/7.*/style.min.css` },
];

let pending: Promise<LmvNamespace> | null = null;

function inject(source: { script: string; style: string }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = source.style;
    style.dataset.lmv = "true";
    document.head.appendChild(style);
    const script = document.createElement("script");
    script.src = source.script;
    script.async = true;
    script.dataset.lmv = "true";
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      style.remove();
      reject(new Error("load failed"));
    };
    document.head.appendChild(script);
  });
}

/** Resolves with the global Autodesk.Viewing namespace once the viewer script has loaded. */
export function loadLmv(): Promise<LmvNamespace> {
  const existing = (window as any).Autodesk?.Viewing;
  if (existing) return Promise.resolve(existing);
  if (!pending) {
    pending = (async () => {
      for (const source of SOURCES) {
        try {
          await inject(source);
          const namespace = (window as any).Autodesk?.Viewing;
          if (namespace) return namespace;
        } catch {
          // Try the next address.
        }
      }
      throw new Error("The Autodesk viewer could not be loaded from developer.api.autodesk.com. Check the internet connection, or whether a content blocker is stopping it.");
    })();
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}
