import type { Metadata } from "next";
import { RvtViewer } from "@/components/viewer/RvtViewer";

export const metadata: Metadata = { title: "RVT viewer" };

export default function RvtPage() {
  return <RvtViewer />;
}
