import type { Metadata } from "next";
import { Suspense } from "react";
import { LivePage } from "@/components/fm/live/LivePage";

export const metadata: Metadata = { title: "Live data" };

export default function Page() {
  return (
    <Suspense>
      <LivePage />
    </Suspense>
  );
}
