// Writes a ZIP archive. Files added with add() are stored as they are; files
// added with addBlob() are deflated with the browser's CompressionStream when
// that makes them smaller.
//
// Used to hand over several .frag files in one download (compressed already,
// so stored) and IFC files with their textures folder (deflated). The archive
// opens in any unzip tool, and in this app (see src/lib/ifc/ifczip.ts). ZIP64
// records are written when the archive grows past 4 GB or 65,535 files; single
// files stay under 4 GB.

import { crc32 } from "@/lib/ifc/zip-archive.mjs";

interface Entry {
  name: Uint8Array<ArrayBuffer>;
  crc: number;
  size: number;
  compressed: number;
  /** 0 stored, 8 deflated. */
  method: number;
  offset: number;
}

const UINT32_MAX = 0xffffffff;

function dosTime(date: Date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = (Math.max(1980, date.getFullYear()) - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly entries: Entry[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private readonly stamp = dosTime(new Date());

  /** @param limit positions and sizes from this value on are written as ZIP64 (lowered in tests only) */
  constructor(private readonly limit = UINT32_MAX) {}

  /** A name that is taken already gets " (2)", " (3)" before its extension. */
  private uniqueName(name: string): string {
    let unique = name;
    for (let n = 2; this.names.has(unique.toLowerCase()); n++) {
      const dot = name.lastIndexOf(".");
      unique = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    }
    this.names.add(unique.toLowerCase());
    return unique;
  }

  private local(name: Uint8Array<ArrayBuffer>, crc: number, size: number, compressed: number, method: number, data: BlobPart) {
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0x0800, true); // file names are UTF-8
    header.setUint16(8, method, true);
    header.setUint16(10, this.stamp.time, true);
    header.setUint16(12, this.stamp.day, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, compressed, true);
    header.setUint32(22, size, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true);
    this.parts.push(header.buffer, name, data);
    this.entries.push({ name, crc, size, compressed, method, offset: this.offset });
    this.offset += 30 + name.length + compressed;
  }

  /** Adds a file, stored. A name that is taken already gets " (2)", " (3)" before its extension. */
  add(name: string, data: Uint8Array<ArrayBuffer>): string {
    const unique = this.uniqueName(name);
    this.local(new TextEncoder().encode(unique), crc32(data), data.length, data.length, 0, data);
    return unique;
  }

  /** Adds a file from a Blob, deflated when that makes it smaller (`deflate` false stores it). */
  async addBlob(name: string, blob: Blob, deflate = true): Promise<string> {
    const unique = this.uniqueName(name);
    let crc = 0;
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32(value, crc);
    }
    let data = blob;
    if (deflate && typeof CompressionStream !== "undefined") {
      try {
        const packed = await new Response(blob.stream().pipeThrough(new CompressionStream("deflate-raw"))).blob();
        if (packed.size < blob.size) data = packed;
      } catch {
        data = blob;
      }
    }
    if (blob.size >= UINT32_MAX) throw new Error(`${unique} is too large for a ZIP archive.`);
    this.local(new TextEncoder().encode(unique), crc, blob.size, data.size, data === blob ? 0 : 8, data);
    return unique;
  }

  finish(): Blob {
    const directoryOffset = this.offset;
    let directorySize = 0;
    for (const entry of this.entries) {
      const far = entry.offset >= this.limit;
      const extra = far ? 12 : 0;
      const record = new DataView(new ArrayBuffer(46 + extra));
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, far ? 45 : 20, true); // version made by
      record.setUint16(6, far ? 45 : 20, true); // version needed
      record.setUint16(8, 0x0800, true);
      record.setUint16(10, entry.method, true);
      record.setUint16(12, this.stamp.time, true);
      record.setUint16(14, this.stamp.day, true);
      record.setUint32(16, entry.crc, true);
      record.setUint32(20, entry.compressed, true);
      record.setUint32(24, entry.size, true);
      record.setUint16(28, entry.name.length, true);
      record.setUint16(30, extra, true);
      record.setUint32(42, far ? UINT32_MAX : entry.offset, true);
      if (far) {
        // ZIP64: the position does not fit in 32 bits and is given in an extra field.
        record.setUint16(46, 0x0001, true);
        record.setUint16(48, 8, true);
        record.setBigUint64(50, BigInt(entry.offset), true);
      }
      // The name sits between the fixed part and the extra field.
      const bytes = new Uint8Array(record.buffer);
      this.parts.push(bytes.slice(0, 46), entry.name, bytes.slice(46));
      directorySize += 46 + entry.name.length + extra;
    }

    const count = this.entries.length;
    const zip64 = directoryOffset >= this.limit || directorySize >= this.limit || count >= 0xffff;
    if (zip64) {
      const record = new DataView(new ArrayBuffer(56 + 20));
      record.setUint32(0, 0x06064b50, true);
      record.setBigUint64(4, 44n, true); // size of the rest of this record
      record.setUint16(12, 45, true);
      record.setUint16(14, 45, true);
      record.setBigUint64(24, BigInt(count), true);
      record.setBigUint64(32, BigInt(count), true);
      record.setBigUint64(40, BigInt(directorySize), true);
      record.setBigUint64(48, BigInt(directoryOffset), true);
      record.setUint32(56, 0x07064b50, true); // locator
      record.setBigUint64(64, BigInt(directoryOffset + directorySize), true);
      record.setUint32(72, 1, true);
      this.parts.push(record.buffer);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    // With ZIP64 the short record only points onward: its own fields are filled with the "see ZIP64" marker.
    end.setUint16(8, zip64 ? 0xffff : count, true);
    end.setUint16(10, zip64 ? 0xffff : count, true);
    end.setUint32(12, zip64 ? UINT32_MAX : directorySize, true);
    end.setUint32(16, zip64 ? UINT32_MAX : directoryOffset, true);
    this.parts.push(end.buffer);
    return new Blob(this.parts, { type: "application/zip" });
  }
}
