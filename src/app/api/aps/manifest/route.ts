import { NextResponse, type NextRequest } from "next/server";
import { errorBody, translationStatus } from "@/lib/aps/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Progress of a translation. Query: urn, output (ifc | svf2). */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const urn = request.nextUrl.searchParams.get("urn") ?? "";
    const output = request.nextUrl.searchParams.get("output") === "svf2" ? "svf2" : "ifc";
    return NextResponse.json(await translationStatus(urn, output));
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}
