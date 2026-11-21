import type { Metadata } from "next";
import { Suspense } from "react";
import { LabelsPage } from "@/components/fm/labels/LabelsPage";

export const metadata: Metadata = { title: "Labels" };

export default function Page() {
  return (
    <Suspense>
      <LabelsPage />
    </Suspense>
  );
}
