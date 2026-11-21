import { NextResponse, type NextRequest } from "next/server";
import { errorBody, startTranslation, type TranslationOutput } from "@/lib/aps/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a translation: Revit to IFC, or Navisworks to a streamable 3D model (SVF2). */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  try {
    const body = (await request.json()) as { urn?: unknown; output?: unknown; exportSettingName?: unknown; hiddenObjects?: unknown; materialProperties?: unknown };
    if (typeof body.urn !== "string") return NextResponse.json({ error: "Missing model reference." }, { status: 400 });
    let output: TranslationOutput;
    if (body.output === "ifc") {
      const name = typeof body.exportSettingName === "string" ? body.exportSettingName.trim().slice(0, 120) : "";
      output = { type: "ifc", exportSettingName: name || undefined };
    } else if (body.output === "svf2") {
      output = { type: "svf2", hiddenObjects: body.hiddenObjects === true, materialProperties: body.materialProperties === true };
    } else return NextResponse.json({ error: "Unknown output format." }, { status: 400 });
    await startTranslation(body.urn, output);
    return NextResponse.json({ started: true });
  } catch (error) {
    const { body, status } = errorBody(error);
    return NextResponse.json(body, { status });
  }
}
