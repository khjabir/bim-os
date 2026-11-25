// Server-side access to Autodesk Platform Services (APS). Only API routes
// import this file: the client id and secret never reach the browser.
//
// Endpoints and payloads follow Autodesk's official Node SDK (@aps_sdk/oss,
// @aps_sdk/model-derivative, @aps_sdk/authentication); plain fetch is used
// here to keep the dependency list short.

// APS_BASE_URL exists so the routes can be exercised against a local mock of the
// Autodesk endpoints; leave it unset for real use.
const BASE = process.env.APS_BASE_URL?.trim().replace(/\/+$/, "") || "https://developer.api.autodesk.com";

/** Size of one upload part. Mirrors the official SDK (S3 needs at least 5 MB per part). */
export const UPLOAD_PART_BYTES = 5 * 1024 * 1024;

const REGIONS = ["US", "EMEA", "AUS", "CAN", "DEU", "IND", "JPN", "GBR"] as const;
export type ApsRegion = (typeof REGIONS)[number];

export class ApsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApsError";
  }
}

export interface ApsConfig {
  clientId: string;
  clientSecret: string;
  region: ApsRegion;
  bucketKey: string;
}

/** The APS settings from .env.local, or null when no credentials are set. */
export function apsConfig(): ApsConfig | null {
  const clientId = process.env.APS_CLIENT_ID?.trim();
  const clientSecret = process.env.APS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const requested = process.env.APS_REGION?.trim().toUpperCase();
  const region = (REGIONS as readonly string[]).includes(requested ?? "") ? (requested as ApsRegion) : "US";
  // Bucket keys are global across all APS apps, so derive one from the client id.
  const custom = process.env.APS_BUCKET?.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const bucketKey = custom && custom.length >= 3 ? custom.slice(0, 128) : `ifcstudio_${clientId.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 128);
  return { clientId, clientSecret, region, bucketKey };
}

function requireConfig(): ApsConfig {
  const config = apsConfig();
  if (!config) throw new ApsError("Autodesk Platform Services is not configured. Add APS_CLIENT_ID and APS_CLIENT_SECRET to .env.local and restart the server.", 503);
  return config;
}

// ---------------------------------------------------------------------------
// Tokens

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokens = new Map<string, CachedToken>();

const INTERNAL_SCOPES = ["bucket:create", "bucket:read", "data:read", "data:write", "data:create"];

/** A two-legged token for the given scopes, cached until shortly before it expires. */
export async function getToken(scopes: string[] = INTERNAL_SCOPES): Promise<{ accessToken: string; expiresIn: number }> {
  const config = requireConfig();
  const key = `${config.clientId}|${scopes.join(" ")}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - Date.now() > 120_000) return { accessToken: cached.token, expiresIn: Math.floor((cached.expiresAt - Date.now()) / 1000) };

  const response = await fetch(`${BASE}/authentication/v2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: scopes.join(" ") }).toString(),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await describe(response);
    const hint = response.status === 401 || response.status === 400 || response.status === 403 ? " Check APS_CLIENT_ID and APS_CLIENT_SECRET, and that the app has the Data Management and Model Derivative APIs enabled." : "";
    throw new ApsError(`Autodesk sign-in failed: ${detail}.${hint}`, response.status === 429 ? 429 : 502);
  }
  const payload = (await response.json()) as { access_token: string; expires_in: number };
  tokens.set(key, { token: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 });
  return { accessToken: payload.access_token, expiresIn: payload.expires_in };
}

/** A short-lived, read-only token the Autodesk viewer in the browser uses to stream a translated model. */
export function getViewerToken() {
  return getToken(["viewables:read"]);
}

// ---------------------------------------------------------------------------
// Requests

async function describe(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // Ignore: the status is all there is.
  }
  if (text) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const message = body.developerMessage ?? body.reason ?? body.diagnostic ?? body.error_description ?? body.detail ?? body.message ?? body.errorCode;
      if (typeof message === "string" && message) return `${message} (HTTP ${response.status})`;
    } catch {
      // Not JSON.
    }
  }
  return text ? `${text.slice(0, 300)} (HTTP ${response.status})` : `HTTP ${response.status}`;
}

async function aps(path: string, init: RequestInit & { regionHeader?: "region" | "x-ads-region" } = {}): Promise<Response> {
  const config = requireConfig();
  const { accessToken } = await getToken();
  const { regionHeader, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (regionHeader) headers.set(regionHeader, config.region);
  return fetch(`${BASE}${path}`, { ...rest, headers, cache: "no-store" });
}

async function apsJson<T>(path: string, init: RequestInit & { regionHeader?: "region" | "x-ads-region" } = {}, what = "The Autodesk request"): Promise<T> {
  const response = await aps(path, init);
  if (!response.ok) throw new ApsError(`${what} failed: ${await describe(response)}`, response.status === 404 ? 404 : response.status === 429 ? 429 : 502);
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Object storage (OSS)

let bucketReady: string | null = null;

/** Creates this app's bucket on first use. Objects in it are deleted by Autodesk after 24 hours. */
export async function ensureBucket(): Promise<string> {
  const config = requireConfig();
  if (bucketReady === config.bucketKey) return config.bucketKey;
  const response = await aps("/oss/v2/buckets", {
    method: "POST",
    regionHeader: "x-ads-region",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucketKey: config.bucketKey, policyKey: "transient" }),
  });
  // 409: the bucket already exists, which is the normal case after the first upload.
  if (!response.ok && response.status !== 409) throw new ApsError(`Could not create the storage bucket "${config.bucketKey}": ${await describe(response)}`, 502);
  bucketReady = config.bucketKey;
  return config.bucketKey;
}

/** Storage name for an upload. The extension is kept because the translator picks its reader by it. */
export function makeObjectKey(fileName: string): string {
  const cleaned = fileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-80);
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${stamp}-${cleaned || "model"}`;
}

export const OBJECT_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function objectPath(bucketKey: string, objectKey: string) {
  return `/oss/v2/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeURIComponent(objectKey)}`;
}

/**
 * Uploads one part of a file. Autodesk hands out a signed storage URL for the
 * part and the bytes go straight to it. Returns the upload session key, which
 * the next part and the final "complete" call need.
 */
export async function uploadPart(objectKey: string, partNumber: number, body: ArrayBuffer, uploadKey?: string): Promise<string> {
  const { bucketKey } = requireConfig();
  const query = new URLSearchParams({ parts: "1", firstPart: String(partNumber), minutesExpiration: "30" });
  if (uploadKey) query.set("uploadKey", uploadKey);
  const signed = await apsJson<{ uploadKey: string; urls: string[] }>(`${objectPath(bucketKey, objectKey)}/signeds3upload?${query}`, {}, "Requesting an upload address");
  const url = signed.urls?.[0];
  if (!url) throw new ApsError("Autodesk returned no upload address for this part.", 502);
  const put = await fetch(url, { method: "PUT", body, cache: "no-store" });
  if (!put.ok) throw new ApsError(`Uploading part ${partNumber} failed (HTTP ${put.status}).`, 502);
  return signed.uploadKey;
}

/** Finishes an upload and returns the URL-safe base64 URN the translator addresses the file by. */
export async function completeUpload(objectKey: string, uploadKey: string, size: number): Promise<string> {
  const { bucketKey } = requireConfig();
  const details = await apsJson<{ objectId?: string }>(
    `${objectPath(bucketKey, objectKey)}/signeds3upload`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadKey, size }) },
    "Completing the upload",
  );
  if (!details.objectId) throw new ApsError("Autodesk did not return an object id for the upload.", 502);
  return toUrn(details.objectId);
}

export function toUrn(objectId: string): string {
  return Buffer.from(objectId, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Checks that a URN names an object in this app's own bucket, so the routes
 * cannot be used to read or translate anything else the credentials can reach.
 * Returns the object key.
 */
export function ownObjectKey(urn: string): string {
  const { bucketKey } = requireConfig();
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(urn)) throw new ApsError("Invalid model reference.", 400);
  const objectId = Buffer.from(urn.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const prefix = `urn:adsk.objects:os.object:${bucketKey}/`;
  if (!objectId.startsWith(prefix)) throw new ApsError("That model does not belong to this app's storage bucket.", 403);
  const objectKey = objectId.slice(prefix.length);
  if (!OBJECT_KEY_PATTERN.test(objectKey)) throw new ApsError("Invalid model reference.", 400);
  return objectKey;
}

// ---------------------------------------------------------------------------
// Model Derivative

export type TranslationOutput =
  | { type: "ifc"; exportSettingName?: string }
  | { type: "svf2"; hiddenObjects?: boolean; materialProperties?: boolean };

/** Starts a translation job. Re-running replaces earlier results of the same output type. */
export async function startTranslation(urn: string, output: TranslationOutput): Promise<void> {
  ownObjectKey(urn);
  const format =
    output.type === "ifc"
      ? { type: "ifc", ...(output.exportSettingName ? { advanced: { exportSettingName: output.exportSettingName } } : {}) }
      : {
          type: "svf2",
          views: ["3d"],
          advanced: {
            hiddenObjects: Boolean(output.hiddenObjects),
            basicMaterialProperties: Boolean(output.materialProperties),
            autodeskMaterialProperties: Boolean(output.materialProperties),
          },
        };
  await apsJson<unknown>(
    "/modelderivative/v2/designdata/job",
    {
      method: "POST",
      regionHeader: "region",
      headers: { "Content-Type": "application/json", "x-ads-force": "true" },
      body: JSON.stringify({ input: { urn }, output: { formats: [format] } }),
    },
    "Starting the translation",
  );
}

interface ManifestMessage {
  type?: string;
  code?: string;
  message?: string | string[];
  args?: unknown;
}

/**
 * A translator message as plain text. Autodesk's translators write some of them as markup with numbered
 * placeholders, e.g. "<message>Missing link files: <ul>{0}</ul></message>" with args ["<li>A.rvt</li>"].
 */
export function plainMessage(message: ManifestMessage): string {
  const raw = Array.isArray(message.message) ? message.message.join(" ") : (message.message ?? "");
  const args = Array.isArray(message.args) ? message.args : [];
  return raw
    .replace(/\{(\d+)\}/g, (_, index: string) => {
      const value = args[Number(index)];
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    })
    .replace(/<\/li>\s*<li>/gi, ", ")
    .replace(/<\/?[a-z][^<>]{0,60}>/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .trim();
}

interface ManifestNode {
  urn?: string;
  role?: string;
  mime?: string;
  type?: string;
  name?: string;
  status?: string;
  outputType?: string;
  progress?: string;
  messages?: ManifestMessage[];
  children?: ManifestNode[];
}

export interface TranslationStatus {
  /** pending, inprogress, success, failed or timeout. "pending" also covers a job Autodesk has not registered yet. */
  status: string;
  /** For example "42% complete" or "complete". */
  progress: string;
  messages: string[];
  /** URN of the generated .ifc file, once an IFC translation has finished. */
  ifcDerivativeUrn: string | null;
  /** True once a 3D viewable exists (SVF2 translation finished). */
  hasViewable: boolean;
}

function walk(nodes: ManifestNode[] | undefined, visit: (node: ManifestNode) => void) {
  for (const node of nodes ?? []) {
    visit(node);
    walk(node.children, visit);
  }
}

/** Progress and results of the translation jobs for one uploaded file. */
export async function translationStatus(urn: string, outputType: "ifc" | "svf2"): Promise<TranslationStatus> {
  ownObjectKey(urn);
  const response = await aps(`/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, { regionHeader: "region" });
  // The manifest appears a moment after the job is accepted.
  if (response.status === 404) return { status: "pending", progress: "0% complete", messages: [], ifcDerivativeUrn: null, hasViewable: false };
  if (!response.ok) throw new ApsError(`Reading the translation status failed: ${await describe(response)}`, response.status === 429 ? 429 : 502);
  const manifest = (await response.json()) as { status?: string; progress?: string; derivatives?: ManifestNode[] };

  const derivative = (manifest.derivatives ?? []).find((entry) => entry.outputType === outputType);
  const messages: string[] = [];
  let ifcDerivativeUrn: string | null = null;
  let hasViewable = false;
  walk(derivative ? [derivative] : [], (node) => {
    for (const message of node.messages ?? []) {
      const text = plainMessage(message);
      if (text) messages.push(message.code ? `${text} (${message.code})` : text);
    }
    if (node.urn && (node.role === "ifc" || /\.ifc$/i.test(node.urn))) ifcDerivativeUrn = node.urn;
    if (node.role === "graphics" || (node.type === "geometry" && node.role === "3d")) hasViewable = true;
  });
  return {
    // The overall status covers every job run on the file; this output's own status is what matters.
    status: derivative?.status ?? (manifest.status === "failed" ? "failed" : "pending"),
    progress: derivative?.progress ?? manifest.progress ?? "",
    messages: [...new Set(messages)].slice(0, 12),
    ifcDerivativeUrn,
    hasViewable,
  };
}

/** Opens a download stream for a generated file (the IFC), using Autodesk's signed-cookie handshake. */
export async function openDerivative(urn: string, derivativeUrn: string): Promise<Response> {
  ownObjectKey(urn);
  if (!derivativeUrn.startsWith("urn:adsk.viewing:fs.file:") || derivativeUrn.length > 2048) throw new ApsError("Invalid derivative reference.", 400);
  const handshake = await aps(`/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest/${encodeURIComponent(derivativeUrn)}/signedcookies`, { regionHeader: "region" });
  if (!handshake.ok) throw new ApsError(`Requesting the download failed: ${await describe(handshake)}`, handshake.status === 404 ? 404 : 502);
  const { url } = (await handshake.json()) as { url?: string };
  if (!url) throw new ApsError("Autodesk returned no download address.", 502);
  // The three CloudFront-* cookies authorise the download.
  const cookies = handshake.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0].trim())
    .filter((cookie) => cookie.startsWith("CloudFront-"));
  let download = await fetch(url, { headers: cookies.length > 0 ? { Cookie: cookies.join("; ") } : undefined, cache: "no-store" });
  if (download.status === 403 && cookies.length > 0) {
    // Same credentials as query parameters, which is how Autodesk's own SDK sends them.
    const signedUrl = new URL(url);
    for (const cookie of cookies) {
      const split = cookie.indexOf("=");
      signedUrl.searchParams.set(cookie.slice("CloudFront-".length, split), cookie.slice(split + 1));
    }
    download = await fetch(signedUrl, { cache: "no-store" });
  }
  if (!download.ok || !download.body) throw new ApsError(`Downloading the converted file failed (HTTP ${download.status}).`, 502);
  return download;
}

/** Removes an uploaded file and everything translated from it. Missing pieces are not an error. */
export async function deleteModel(urn: string): Promise<void> {
  const objectKey = ownObjectKey(urn);
  const { bucketKey } = requireConfig();
  const manifest = await aps(`/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, { method: "DELETE", regionHeader: "region" });
  const object = await aps(objectPath(bucketKey, objectKey), { method: "DELETE" });
  for (const response of [manifest, object]) {
    if (!response.ok && response.status !== 404) throw new ApsError(`Deleting the cloud copy failed: ${await describe(response)}`, 502);
  }
}

/** Shapes any error into the JSON body and status an API route should answer with. */
export function errorBody(error: unknown): { body: { error: string }; status: number } {
  if (error instanceof ApsError) return { body: { error: error.message }, status: error.status };
  const message = error instanceof Error ? error.message : "Request failed.";
  return { body: { error: /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message) ? "Could not reach Autodesk's servers. Check the internet connection and try again." : message }, status: 502 };
}
