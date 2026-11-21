import type { Metadata } from "next";
import { Suspense } from "react";
import { FieldPage } from "@/components/fm/field/FieldApp";

export const metadata: Metadata = { title: "Field app" };

export default function Page() {
  return (
    <Suspense>
      <FieldPage />
    </Suspense>
  );
}
