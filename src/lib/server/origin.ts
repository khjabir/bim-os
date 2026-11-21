import type { NextRequest } from "next/server";

/**
 * True when a request comes from this app's own pages. The API routes spend
 * the owner's API credit or cloud quota, so other sites must not be able to
 * call them from a visitor's browser. This is enough for local use; put real
 * authentication in front of the routes before deploying anywhere public.
 */
export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // Browsers omit Origin on same-origin GETs; a cross-site fetch always sends it or Sec-Fetch-Site.
    const site = request.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}
