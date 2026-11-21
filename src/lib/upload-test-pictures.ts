// Builds the smallest byte strings that carry a real PNG or JPEG header, for tests only.
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function pngWithSize(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  PNG_SIGNATURE.copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8; // bit depth
  header[25] = 6; // colour type
  return header;
}

/** A JPEG made of an SOI, an APP0 segment and one start-of-frame segment. */
export function jpegWithSize(
  width: number,
  height: number,
  frameMarker = 0xc0,
  extraSegments: Buffer[] = [],
): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff;
  frame[1] = frameMarker;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app0,
    ...extraSegments,
    frame,
  ]);
}

