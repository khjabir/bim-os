import type { Metadata } from "next";
import { Suspense } from "react";
import { OnboardWizard } from "@/components/fm/onboard/OnboardWizard";

export const metadata: Metadata = { title: "Onboard a building" };

export default function Page() {
  return (
    <Suspense>
      <OnboardWizard />
    </Suspense>
  );
}
