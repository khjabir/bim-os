import { NextResponse } from "next/server";
import { apsConfig } from "@/lib/aps/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the pages whether Autodesk cloud conversion is set up. Never returns the credentials. */
export async function GET() {
  const config = apsConfig();
  return NextResponse.json({ configured: Boolean(config), region: config?.region ?? null });
}
