import { NextResponse, type NextRequest } from "next/server";
import { errorBody, getViewerToken } from "@/lib/aps/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A short-lived token for the Autodesk viewer on the NWD page. It carries the
 * viewables:read scope only: it can stream translated models, and cannot
 * upload, translate, list or delete anything.
 */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const { accessToken, expiresIn } = await getViewerToken();
    return NextResponse.json({ access_token: accessToken, expires_in: expiresIn }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}
