import { NextResponse, type NextRequest } from "next/server";
import { errorBody, openDerivative } from "@/lib/aps/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams a translated file (the IFC) back to the page. Query: urn, derivativeUrn. */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const urn = request.nextUrl.searchParams.get("urn") ?? "";
    const derivativeUrn = request.nextUrl.searchParams.get("derivativeUrn") ?? "";
    const download = await openDerivative(urn, derivativeUrn);
    const headers = new Headers({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
    const length = download.headers.get("content-length");
    // Only pass the length on when the body is not transparently decompressed on the way.
    if (length && !download.headers.get("content-encoding")) headers.set("Content-Length", length);
    return new Response(download.body, { status: 200, headers });
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}
