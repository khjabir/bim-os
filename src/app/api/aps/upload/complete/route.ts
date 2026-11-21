import { NextResponse, type NextRequest } from "next/server";
import { completeUpload, errorBody, OBJECT_KEY_PATTERN } from "@/lib/aps/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Finishes an upload and returns the URN the translator addresses the file by. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const { objectKey, uploadKey, size } = (await request.json()) as { objectKey?: unknown; uploadKey?: unknown; size?: unknown };
    if (typeof objectKey !== "string" || !OBJECT_KEY_PATTERN.test(objectKey) || typeof uploadKey !== "string" || !uploadKey || typeof size !== "number") {
      return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
    }
    return NextResponse.json({ urn: await completeUpload(objectKey, uploadKey, size) });
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}
