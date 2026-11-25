import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // "1" when the optional DWG add-on (addons/dwg) is installed in public/addons/dwg/ as the app is built
    // or the development server starts; only then does the app look for it (src/lib/convert/plans/dwgAddon.ts).
    NEXT_PUBLIC_DWG_ADDON: existsSync(join(process.cwd(), "public", "addons", "dwg", "addon.json")) ? "1" : "",
  },
  // The 3D engine owns a WebGL context and several web workers. Mounting it
  // twice in development (React StrictMode) doubles memory use on big models.
  reactStrictMode: false,
  // The floating Next.js badge sits on top of the viewer's tool rail.
  devIndicators: false,
  turbopack: {
    resolveAlias: {
      // See src/lib/shims/three.js: adds the WebGPU-only names That Open Engine
      // probes for, as undefined, so Turbopack accepts the classic three build.
      three: "./src/lib/shims/three.js",
    },
  },
};

export default nextConfig;
