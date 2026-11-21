import type { Metadata } from "next";
import { NwdViewer } from "@/components/nwd/NwdViewer";

export const metadata: Metadata = { title: "NWD viewer" };

export default function NwdPage() {
  return <NwdViewer />;
}
