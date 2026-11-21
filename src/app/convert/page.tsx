import type { Metadata } from "next";
import { ConvertWorkbench } from "@/components/convert/ConvertWorkbench";

export const metadata: Metadata = { title: "Convert to IFC" };

export default function ConvertPage() {
  return <ConvertWorkbench />;
}
