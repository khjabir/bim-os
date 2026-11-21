import type { Metadata } from "next";
import { IfcViewer } from "@/components/viewer/IfcViewer";

export const metadata: Metadata = { title: "IFC viewer" };

export default function IfcPage() {
  return <IfcViewer />;
}
