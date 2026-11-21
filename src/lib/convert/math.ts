// Small affine-transform helpers. An Affine is a row-major 3x4 matrix
// [r00 r01 r02 t0, r10 r11 r12 t1, r20 r21 r22 t2] in a Float64Array(12).

export type Affine = Float64Array;

export function identity(): Affine {
  return Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
}

export function translation(x: number, y: number, z: number): Affine {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z);
}

export function scaling(s: number): Affine {
  return Float64Array.of(s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0);
}

/** Rotation by `radians` about +Z. */
export function rotationZ(radians: number): Affine {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return Float64Array.of(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0);
}

/** a · b (b applied first). */
export function multiply(a: Affine, b: Affine): Affine {
  const out = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4],
      a1 = a[r * 4 + 1],
      a2 = a[r * 4 + 2],
      a3 = a[r * 4 + 3];
    out[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    out[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    out[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    out[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
  }
  return out;
}

export function chain(...matrices: Affine[]): Affine {
  return matrices.reduce((acc, m) => multiply(acc, m));
}

export function invert(m: Affine): Affine {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) throw new Error("Singular transform");
  const inv = 1 / det;
  const r00 = A * inv,
    r01 = -(b * i - c * h) * inv,
    r02 = (b * f - c * e) * inv;
  const r10 = B * inv,
    r11 = (a * i - c * g) * inv,
    r12 = -(a * f - c * d) * inv;
  const r20 = C * inv,
    r21 = -(a * h - b * g) * inv,
    r22 = (a * e - b * d) * inv;
  return Float64Array.of(
    r00, r01, r02, -(r00 * tx + r01 * ty + r02 * tz),
    r10, r11, r12, -(r10 * tx + r11 * ty + r12 * tz),
    r20, r21, r22, -(r20 * tx + r21 * ty + r22 * tz),
  );
}

export function determinant3(m: Affine): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}

/** Fragment matrix as stored by the extractor (3x3 column-major, then translation) -> Affine. */
export function fromFragment(e: Float32Array, at: number): Affine {
  return Float64Array.of(e[at], e[at + 3], e[at + 6], e[at + 9], e[at + 1], e[at + 4], e[at + 7], e[at + 10], e[at + 2], e[at + 5], e[at + 8], e[at + 11]);
}

export function apply(m: Affine, x: number, y: number, z: number, out: Float64Array | number[], at = 0) {
  out[at] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[at + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[at + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}

/** Axis-aligned bounds of a box after a transform: [minX, minY, minZ, maxX, maxY, maxZ]. */
export function transformBox(m: Affine, box: ArrayLike<number>, at: number, out: Float64Array) {
  const p = [0, 0, 0];
  out[0] = out[1] = out[2] = Infinity;
  out[3] = out[4] = out[5] = -Infinity;
  for (let k = 0; k < 8; k++) {
    apply(m, box[at + (k & 1 ? 3 : 0)], box[at + 1 + (k & 2 ? 3 : 0)], box[at + 2 + (k & 4 ? 3 : 0)], p);
    for (let j = 0; j < 3; j++) {
      if (p[j] < out[j]) out[j] = p[j];
      if (p[j] > out[j + 3]) out[j + 3] = p[j];
    }
  }
}
