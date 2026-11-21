import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
