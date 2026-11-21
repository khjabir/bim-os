import { NextResponse, type NextRequest } from "next/server";
import { deleteModel, errorBody } from "@/lib/aps/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deletes an uploaded file and its translations from Autodesk's cloud. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const { urn } = (await request.json()) as { urn?: unknown };
    if (typeof urn !== "string") return NextResponse.json({ error: "Missing model reference." }, { status: 400 });
    await deleteModel(urn);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}
