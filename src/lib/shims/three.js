// Bundler shim for the bare "three" import (wired up in next.config.ts).
//
// That Open Engine supports both three.js builds and probes for the WebGPU one
// at run time with expressions such as `THREE.NodeMaterial ?? class {}`. The
// classic build has no such exports, and Turbopack turns a statically missing
// namespace member into a build error. Re-exporting the classic build together
// with explicit `undefined` placeholders keeps the probes working exactly as
// they do under other bundlers: they read `undefined` and take the WebGL path.

export * from "../../../node_modules/three/build/three.module.js";

export const WebGPURenderer = undefined;
export const NodeMaterial = undefined;
export const PointsNodeMaterial = undefined;
export const MRTNode = undefined;
export const TSL = undefined;
