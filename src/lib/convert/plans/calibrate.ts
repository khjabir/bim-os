// Plan pixels <-> project metres. Image y runs down the page; project Y runs north (up the page).

export interface PlanCalibration {
  /** Metres per image pixel. */
  metresPerPixel: number;
  /** The image point that sits at `origin`. */
  originPx: [number, number];
  /** Project coordinates (metres, relative to the site origin) of `originPx`. */
  origin: [number, number];
  /** Rotation of the image's x axis to the project X axis, degrees counter-clockwise. */
  rotationDeg: number;
}

export function pxToProject(cal: PlanCalibration, p: [number, number]): [number, number] {
  const sx = (p[0] - cal.originPx[0]) * cal.metresPerPixel;
  const sy = -(p[1] - cal.originPx[1]) * cal.metresPerPixel;
  const r = (cal.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r),
    s = Math.sin(r);
  return [round(cal.origin[0] + sx * c - sy * s), round(cal.origin[1] + sx * s + sy * c)];
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Rotation that makes the image line p -> q run along project +X. */
export function rotationFromLine(p: [number, number], q: [number, number]): number {
  // Image angle of the line, with y flipped to point up.
  const angle = Math.atan2(-(q[1] - p[1]), q[0] - p[0]);
  return Math.round((-angle * 180) / Math.PI * 1000) / 1000;
}

export function distancePx(p: [number, number], q: [number, number]) {
  return Math.hypot(q[0] - p[0], q[1] - p[1]);
}
