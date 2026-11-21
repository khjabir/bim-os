import type { Metadata } from "next";
import { Suspense } from "react";
import { MaintenancePage } from "@/components/fm/maintenance/MaintenancePage";

export const metadata: Metadata = { title: "Maintenance" };

export default function Page() {
  return (
    <Suspense>
      <MaintenancePage />
    </Suspense>
  );
}
