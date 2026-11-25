// Messages between the Convert page and the vector plan worker.

import type { ScaleGuess } from "./pictureScale";
import type { PictureOptions, PictureStats, TextBox, TextSheets } from "./raster";
import type { LayerRole, RecognizeOptions } from "./recognize";
import type { LayerPaths, PlanView, VectorDrawing } from "./vector";

type Px = [number, number];
type Box = [number, number, number, number];

export interface DrawingInfo {
  layers: { name: string; color: string; off: boolean; count: number }[];
  /** Metres per drawing unit from the file, or null when unitless. */
  unitScale: number | null;
  unitLabel: string;
  /** For unitless drawings: the units the door sizes or the plan's size suggest. */
  unitGuess: { scale: number; label: string; basis: "doors" | "size" } | null;
  roles: LayerRole[];
  /** Separate plans found in the drawing (drawing units), in sheet order. */
  regions: Box[];
  bbox: Box;
  notes: string[];
  version: string;
  binary: boolean;
  paperSpace?: number;
  entities?: number;
}

/** A picture read as line work: its layers (inks), the lines of text to read, and what the doors say about the scale. */
export interface PictureInfo extends DrawingInfo {
  sheets: TextSheets;
  boxes: TextBox[];
  stats: PictureStats;
  doors: ScaleGuess | null;
}

/** After the text was read: the layers' roles again, and the scale the picture gives. */
export interface PictureTexts {
  layers: DrawingInfo["layers"];
  roles: LayerRole[];
  scale: ScaleGuess | null;
  candidates: ScaleGuess[];
  texts: number;
}

export interface PxWall {
  a: Px;
  b: Px;
  thickness: number;
}

export interface PxOpening {
  a: Px;
  b: Px;
  kind: "door" | "window" | "opening";
  /** Unit vector the door opens towards, image axes (y down). */
  swing: Px | null;
  operation: string | null;
  name: string | null;
}

export interface PxRoom {
  outline: Px[];
  name: string | null;
  number: string | null;
}

export interface PxColumn {
  outline: Px[] | null;
  circle: { c: Px; r: number } | null;
}

export interface PxRecognized {
  walls: PxWall[];
  openings: PxOpening[];
  rooms: PxRoom[];
  columns: PxColumn[];
  outline: Px[];
  warnings: string[];
  stats: { wallLines: number; pairedShare: number; fillChecked: boolean; singleLines: boolean; seconds: number };
}

export type RecognizeSettings = Pick<RecognizeOptions, "minThickness" | "maxThickness" | "singleLines" | "defaultThickness" | "rooms">;

export type VectorRequest =
  | { type: "open-dxf"; id: string; bytes: ArrayBuffer }
  | { type: "open"; id: string; drawing: VectorDrawing }
  | { type: "roles"; id: string; unitScale: number | null }
  | { type: "paths"; id: string; region: Box; view: PlanView }
  | { type: "recognize"; id: string; region: Box; view: PlanView; roles: LayerRole[]; unitScale: number; settings: RecognizeSettings }
  | {
      type: "rooms";
      walls: PxWall[];
      columns: PxColumn[];
      /** Metres per pixel. */
      unitScale: number;
      /** Room names come from the drawing's texts when it has one. */
      drawing?: { id: string; region: Box; view: PlanView; roles: LayerRole[] };
    }
  | { type: "open-picture"; id: string; width: number; height: number; gray: Uint8Array; options: PictureOptions }
  | {
      type: "picture-texts";
      id: string;
      texts: { box: number; text: string }[];
      /** Metres per pixel at 1:1 (PDF page size or the picture's resolution), and how it is known ("300 dpi"). */
      metresPerPixelAtFullSize: number | null;
      sizeLabel: string | null;
    }
  | { type: "area-check"; id: string; rooms: Px[][]; view: PlanView; unitScale: number }
  | {
      type: "room-at";
      walls: PxWall[];
      columns: PxColumn[];
      /** Metres per pixel. */
      unitScale: number;
      at: Px;
      drawing?: { id: string; region: Box; view: PlanView; roles: LayerRole[] };
    }
  | { type: "release"; id: string };

export interface VectorResponse {
  seq: number;
  result?: DrawingInfo | PictureInfo | PictureTexts | { roles: LayerRole[] } | { paths: LayerPaths[]; texts: ReturnType<typeof import("./vector").regionTexts> } | PxRecognized | { rooms: PxRoom[]; outline: Px[] } | PxRoom | { factor: number; support: number } | null;
  error?: string;
}
