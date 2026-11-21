import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppHeader } from "@/components/shell/AppHeader";

export const metadata: Metadata = {
  title: { default: "IFC Studio", template: "%s · IFC Studio" },
  description:
    "Open IFC, RVT and NWD models in the browser, analyse them, and export Fragments or IFC. Built on That Open Engine.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#15191f" },
  ],
};

// Applies the saved (or system) theme before first paint to avoid a flash.
const themeScript = `(function(){try{var t=localStorage.getItem("ifc-studio-theme");var d=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <div className="flex h-dvh flex-col">
          <AppHeader />
          <main className="min-h-0 flex-1">{children}</main>
        </div>
      </body>
    </html>
  );
}
