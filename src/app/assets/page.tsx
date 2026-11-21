import type { Metadata } from "next";
import { Suspense } from "react";
import { AssetsPage } from "@/components/fm/assets/AssetsPage";

export const metadata: Metadata = { title: "Assets" };

export default function Page() {
  return (
    <Suspense>
      <AssetsPage />
    </Suspense>
  );
}
