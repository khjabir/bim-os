// Browser side of the Autodesk cloud (APS) workflow: upload a file through
// the local API routes, start a translation, wait for it, fetch the result.

export interface ApsStatus {
  configured: boolean;
  region: string | null;
}

export interface TranslationStatus {
  status: string;
  progress: string;
  messages: string[];
  ifcDerivativeUrn: string | null;
  hasViewable: boolean;
}

export class ApsCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "ApsCancelled";
  }
}

export class ApsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApsRequestError";
  }
}

function isAbort(error: unknown) {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

async function call<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { ...init, cache: "no-store" });
  } catch (error) {
    if (isAbort(error)) throw new ApsCancelled();
    throw new ApsRequestError("Could not reach the local server.", 0);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Fall through with the status.
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : `Request failed (HTTP ${response.status}).`;
    throw new ApsRequestError(message, response.status);
  }
  return payload as T;
}

export async function getApsStatus(): Promise<ApsStatus> {
  try {
    return await call<ApsStatus>("/api/aps/status");
  } catch {
    return { configured: false, region: null };
  }
}

const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

/** Uploads a file to the app's Autodesk storage bucket in parts. Resolves with the model's URN. */
export async function uploadToAps(file: Blob, fileName: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<string> {
  const { objectKey, partSize, partCount } = await call<{ objectKey: string; partSize: number; partCount: number }>("/api/aps/upload", json({ fileName, size: file.size }, signal));
  let uploadKey = "";
  for (let part = 1; part <= partCount; part++) {
    if (signal?.aborted) throw new ApsCancelled();
    const chunk = file.slice((part - 1) * partSize, Math.min(file.size, part * partSize));
    const query = new URLSearchParams({ objectKey, part: String(part) });
    if (uploadKey) query.set("uploadKey", uploadKey);
    let attempt = 0;
    for (;;) {
      try {
        ({ uploadKey } = await call<{ uploadKey: string }>(`/api/aps/upload?${query}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk, signal }));
        break;
      } catch (error) {
        attempt += 1;
        // A dropped connection on one part is worth another try; a refusal is not.
        const retryable = error instanceof ApsRequestError && (error.status === 0 || error.status === 502 || error.status === 429);
        if (!retryable || attempt >= 3) throw error;
        await sleep(1500 * attempt, signal);
      }
    }
    onProgress(part / partCount);
  }
  const { urn } = await call<{ urn: string }>("/api/aps/upload/complete", json({ objectKey, uploadKey, size: file.size }, signal));
  return urn;
}

export function startTranslation(urn: string, output: { output: "ifc"; exportSettingName?: string } | { output: "svf2"; hiddenObjects?: boolean; materialProperties?: boolean }, signal?: AbortSignal) {
  return call<{ started: boolean }>("/api/aps/translate", json({ urn, ...output }, signal));
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ApsCancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApsCancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** "42% complete" -> 0.42; "complete" -> 1. */
export function progressFraction(progress: string): number | undefined {
  if (/^complete$/i.test(progress.trim())) return 1;
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(progress);
  return match ? Math.min(1, Number(match[1]) / 100) : undefined;
}

/** Polls a translation until it succeeds or fails. Big models can take many minutes. */
export async function waitForTranslation(
  urn: string,
  output: "ifc" | "svf2",
  onProgress: (status: TranslationStatus) => void,
  signal?: AbortSignal,
  timeoutMs = 60 * 60 * 1000,
): Promise<TranslationStatus> {
  const started = Date.now();
  let delay = 2000;
  let failures = 0;
  for (;;) {
    await sleep(delay, signal);
    let status: TranslationStatus;
    try {
      status = await call<TranslationStatus>(`/api/aps/manifest?${new URLSearchParams({ urn, output })}`, { signal });
      failures = 0;
    } catch (error) {
      if (error instanceof ApsCancelled) throw error;
      failures += 1;
      // The job keeps running on Autodesk's side; ride out a few failed polls.
      if (failures >= 5) throw error;
      continue;
    }
    onProgress(status);
    const done = output === "ifc" ? Boolean(status.ifcDerivativeUrn) : status.hasViewable;
    if (status.status === "success" && done) return status;
    if (status.status === "failed" || status.status === "timeout") {
      throw new ApsRequestError(status.messages.length > 0 ? `Autodesk could not translate the file: ${status.messages.join(" ")}` : "Autodesk could not translate the file.", 422);
    }
    if (status.status === "success" && !done) {
      throw new ApsRequestError(output === "ifc" ? "The translation finished but produced no IFC file." : "The translation finished but produced no 3D view.", 422);
    }
    if (Date.now() - started > timeoutMs) throw new ApsRequestError("The translation is taking longer than an hour. It may still finish on Autodesk's side; try again later.", 504);
    delay = Math.min(8000, Math.round(delay * 1.25));
  }
}

/** Downloads a translated file through the local server. */
export async function downloadDerivative(urn: string, derivativeUrn: string, onProgress: (loadedBytes: number, totalBytes: number | null) => void, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`/api/aps/derivative?${new URLSearchParams({ urn, derivativeUrn })}`, { signal, cache: "no-store" });
  } catch (error) {
    if (isAbort(error)) throw new ApsCancelled();
    throw new ApsRequestError("Could not reach the local server.", 0);
  }
  if (!response.ok || !response.body) {
    let message = `Download failed (HTTP ${response.status}).`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the generic message.
    }
    throw new ApsRequestError(message, response.status);
  }
  const total = Number(response.headers.get("content-length")) || null;
  const reader = response.body.getReader();
  const parts: BlobPart[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.byteLength;
      onProgress(loaded, total);
    }
  } catch (error) {
    if (isAbort(error)) throw new ApsCancelled();
    throw new ApsRequestError("The download was interrupted.", 0);
  }
  return new Blob(parts, { type: "application/x-step" });
}

/** Deletes the uploaded file and its translations from Autodesk's cloud. Failures are reported, not thrown. */
export async function deleteFromAps(urn: string): Promise<boolean> {
  try {
    await call<{ deleted: boolean }>("/api/aps/delete", json({ urn }));
    return true;
  } catch {
    return false;
  }
}
