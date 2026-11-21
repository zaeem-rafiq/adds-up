import { createCanvas, loadImage } from "@napi-rs/canvas";
import { describe, expect, test } from "vitest";
import {
  drawStatementPng,
  drawStatementWithLayout,
  type CellBox,
} from "./draw-statement";
import { loadStatement } from "./statements";

async function countDarkPixelsInBox(
  png: Buffer,
  box: CellBox,
  threshold = 80,
): Promise<{ darkPixels: number; pureBlackPixels: number; totalPixels: number }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);

  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const width = Math.min(image.width - x, Math.ceil(box.width));
  const height = Math.min(image.height - y, Math.ceil(box.height));

  const { data } = ctx.getImageData(x, y, width, height);
  let darkPixels = 0;
  let pureBlackPixels = 0;
  const totalPixels = width * height;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a > 200 && r < threshold && g < threshold && b < threshold) {
      darkPixels += 1;
      if (r === 0 && g === 0 && b === 0) {
        pureBlackPixels += 1;
      }
    }
  }

  return { darkPixels, pureBlackPixels, totalPixels };
}

describe("Statement PNG drawing", () => {
  test("draws a PNG with dark pixels where every number is printed (fails if fonts are missing)", async () => {
    process.env.ADDS_UP_TEST = "1";
    const { statement } = await loadStatement("320193");

    const { png, layout } = drawStatementWithLayout(statement);

    // Valid PNG header
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(layout.width).toBe(1200);
    expect(layout.height).toBeGreaterThan(400);

    const numberBoxes = layout.rowBoxes.filter((box) => box.kind === "number");
    expect(numberBoxes.length).toBeGreaterThan(0);

    for (const rowBox of numberBoxes) {
      const row = statement.rows[rowBox.rowIndex];
      if (row.kind !== "number") continue;

      for (const colIndex of [0, 1] as const) {
        if (!row.values[colIndex]) continue;
        const stats = await countDarkPixelsInBox(png, rowBox.cells[colIndex]);
        expect(
          stats.darkPixels,
          `expected dark pixels for "${row.label}" col ${colIndex} (${row.values[colIndex]})`,
        ).toBeGreaterThan(40);
      }
    }
  });

  test("supports covering one cell with a solid black box and overriding one cell's text", async () => {
    process.env.ADDS_UP_TEST = "1";
    const { statement } = await loadStatement("320193");

    const inventoriesIndex = statement.rows.findIndex(
      (row) => row.kind === "number" && row.label === "Inventories",
    );
    expect(inventoriesIndex).toBeGreaterThan(-1);

    const base = drawStatementWithLayout(statement);
    const covered = drawStatementWithLayout(statement, {
      coverCell: { rowIndex: inventoriesIndex, colIndex: 0 },
    });
    const overriddenPng = drawStatementPng(statement, {
      overrideCell: {
        rowIndex: inventoriesIndex,
        colIndex: 0,
        value: "15,541",
      },
    });

    const cellBox = covered.layout.rowBoxes[inventoriesIndex].cells[0];
    const baseStats = await countDarkPixelsInBox(base.png, cellBox);
    const coveredStats = await countDarkPixelsInBox(covered.png, cellBox);

    // Covered cell has a solid black rectangle: far more pure-black pixels than text alone.
    expect(coveredStats.pureBlackPixels).toBeGreaterThan(2000);
    expect(coveredStats.darkPixels).toBeGreaterThan(baseStats.darkPixels * 3);

    // Overridden PNG differs from base PNG.
    expect(Buffer.compare(base.png, overriddenPng)).not.toBe(0);
  });
});
