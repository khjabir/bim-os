// Upload relay: the browser sends a file in 5 MB parts and this route passes
// each part on to Autodesk's storage. The parts travel through the local
// server so the Autodesk credentials stay out of the browser.

import { NextResponse, type NextRequest } from "next/server";
import { ensureBucket, errorBody, makeObjectKey, OBJECT_KEY_PATTERN, UPLOAD_PART_BYTES, uploadPart } from "@/lib/aps/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = /\.(rvt|rfa|rte|nwd|nwc)$/i;

/** Starts an upload: makes sure the bucket exists and names the object. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const { fileName, size } = (await request.json()) as { fileName?: unknown; size?: unknown };
    if (typeof fileName !== "string" || !ALLOWED.test(fileName)) return NextResponse.json({ error: "Only .rvt, .rfa, .rte, .nwd and .nwc files can be sent to Autodesk." }, { status: 400 });
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return NextResponse.json({ error: "The file is empty." }, { status: 400 });
    await ensureBucket();
    return NextResponse.json({ objectKey: makeObjectKey(fileName), partSize: UPLOAD_PART_BYTES, partCount: Math.max(1, Math.ceil(size / UPLOAD_PART_BYTES)) });
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}

/** Uploads one part. Query: objectKey, part (1-based), uploadKey (from the previous part). */
export async function PUT(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const query = request.nextUrl.searchParams;
    const objectKey = query.get("objectKey") ?? "";
    const part = Number(query.get("part"));
    const uploadKey = query.get("uploadKey") || undefined;
    if (!OBJECT_KEY_PATTERN.test(objectKey) || !Number.isInteger(part) || part < 1 || part > 10_000) return NextResponse.json({ error: "Invalid upload part." }, { status: 400 });
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > UPLOAD_PART_BYTES) return NextResponse.json({ error: "Invalid upload part size." }, { status: 400 });
    return NextResponse.json({ uploadKey: await uploadPart(objectKey, part, body, uploadKey) });
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}
