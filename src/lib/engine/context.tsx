"use client";

import { createContext, useContext } from "react";
import type { ViewerEngine } from "./engine";

export const EngineContext = createContext<ViewerEngine | null>(null);

/** The live engine, or null while it is starting up. */
export function useEngine(): ViewerEngine | null {
  return useContext(EngineContext);
}
