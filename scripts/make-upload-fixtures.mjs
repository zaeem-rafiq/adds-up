#!/usr/bin/env node
/**
 * Generates the two small PNG fixture files under src/fixtures/uploads/
 * using @napi-rs/canvas and the bundled DejaVu Sans font:
 *   1. statement-apple.png — Apple's fixture balance sheet drawn with the statement renderer.
 *   2. holiday-photo.png   — a simple sunny beach picture with no financial statement.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const FONT_FAMILY = "AddsUpDejaVu";
const REGULAR_FONT_PATH = path.join(
  process.cwd(),
  "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf",
);
const BOLD_FONT_PATH = path.join(
  process.cwd(),
  "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf",
);

function registerFonts() {
  if (!existsSync(REGULAR_FONT_PATH) || !existsSync(BOLD_FONT_PATH)) {
    throw new Error("Missing DejaVu Sans fonts in node_modules/dejavu-fonts-ttf.");
  }
  GlobalFonts.registerFromPath(REGULAR_FONT_PATH, FONT_FAMILY, {
    weight: "400",
    style: "normal",
  });
  GlobalFonts.registerFromPath(BOLD_FONT_PATH, FONT_FAMILY, {
    weight: "700",
    style: "normal",
  });
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function drawStatementFixture(statement) {
  const IMAGE_WIDTH = 1200;
  const PADDING_X = 56;
  const PADDING_TOP = 48;
  const PADDING_BOTTOM = 56;
  const COL_GAP = 220;
  const COL_BOX_WIDTH = 188;
  const RIGHT_COL_RIGHT_X = IMAGE_WIDTH - PADDING_X;
  const LEFT_COL_RIGHT_X = RIGHT_COL_RIGHT_X - COL_GAP;
  const LABEL_RIGHT_LIMIT = LEFT_COL_RIGHT_X - COL_BOX_WIDTH - 24;
  const INDENT_STEP = 28;
  const LINE_HEIGHT = 27;
  const ROW_BASE_PAD_Y = 9;

  const TITLE_FONT = `700 24px "${FONT_FAMILY}"`;
  const UNIT_FONT = `400 17px "${FONT_FAMILY}"`;
  const COL_HEADER_FONT = `700 17px "${FONT_FAMILY}"`;
  const ROW_REGULAR_FONT = `400 19px "${FONT_FAMILY}"`;
  const ROW_BOLD_FONT = `700 19px "${FONT_FAMILY}"`;

  const measureCanvas = createCanvas(IMAGE_WIDTH, 100);
  const measureCtx = measureCanvas.getContext("2d");

  measureCtx.font = TITLE_FONT;
  const titleLines = wrapText(
    measureCtx,
    statement.title || "CONSOLIDATED BALANCE SHEETS",
    IMAGE_WIDTH - PADDING_X * 2,
  );
  measureCtx.font = UNIT_FONT;
  const unitLines = statement.unitLine
    ? wrapText(measureCtx, statement.unitLine, IMAGE_WIDTH - PADDING_X * 2)
    : [];
  measureCtx.font = COL_HEADER_FONT;
  const col0Lines = wrapText(measureCtx, statement.columns[0], COL_BOX_WIDTH);
  const col1Lines = wrapText(measureCtx, statement.columns[1], COL_BOX_WIDTH);
  const colHeaderLineCount = Math.max(col0Lines.length, col1Lines.length);

  let y = PADDING_TOP;
  const titleY = y;
  y += titleLines.length * 32;
  const unitY = y + 4;
  if (unitLines.length > 0) y += 4 + unitLines.length * 24;
  y += 26;
  const colHeaderY = y;
  y += colHeaderLineCount * 24 + 18;

  const prepared = [];
  for (let i = 0; i < statement.rows.length; i += 1) {
    const row = statement.rows[i];
    const isBold = row.kind === "heading" || row.isTotal;
    measureCtx.font = isBold ? ROW_BOLD_FONT : ROW_REGULAR_FONT;
    const labelX = PADDING_X + row.indent * INDENT_STEP;
    const labelLines = wrapText(
      measureCtx,
      row.label,
      Math.max(220, LABEL_RIGHT_LIMIT - labelX),
    );
    const extraTop =
      row.kind === "heading" && i > 0
        ? 14
        : row.kind === "number" && row.isTotal
          ? 8
          : 0;
    const lower = row.label.trim().toLowerCase();
    const isGrandTotal =
      row.kind === "number" &&
      row.isTotal &&
      (lower === "total assets" || i === statement.rows.length - 1);
    const height =
      labelLines.length * LINE_HEIGHT +
      ROW_BASE_PAD_Y * 2 +
      (isGrandTotal ? 8 : 0);
    y += extraTop;
    prepared.push({ row, labelLines, topOffset: y, height, isGrandTotal });
    y += height;
  }

  const totalHeight = Math.max(240, Math.ceil(y + PADDING_BOTTOM));
  const canvas = createCanvas(IMAGE_WIDTH, totalHeight);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, IMAGE_WIDTH, totalHeight);

  ctx.fillStyle = "#111111";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = TITLE_FONT;
  titleLines.forEach((line, i) => ctx.fillText(line, PADDING_X, titleY + i * 32));

  ctx.fillStyle = "#333333";
  ctx.font = UNIT_FONT;
  unitLines.forEach((line, i) => ctx.fillText(line, PADDING_X, unitY + i * 24));

  ctx.fillStyle = "#111111";
  ctx.font = COL_HEADER_FONT;
  ctx.textAlign = "right";
  const colHeaderBottom = colHeaderY + colHeaderLineCount * 24;
  col0Lines.forEach((line, i) =>
    ctx.fillText(line, LEFT_COL_RIGHT_X, colHeaderBottom - (col0Lines.length - i) * 24),
  );
  col1Lines.forEach((line, i) =>
    ctx.fillText(line, RIGHT_COL_RIGHT_X, colHeaderBottom - (col1Lines.length - i) * 24),
  );

  for (const item of prepared) {
    const { row, labelLines, topOffset, height, isGrandTotal } = item;
    const isBold = row.kind === "heading" || row.isTotal;
    const labelX = PADDING_X + row.indent * INDENT_STEP;

    if (row.kind === "number" && row.isTotal) {
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(LEFT_COL_RIGHT_X - COL_BOX_WIDTH + 16, topOffset + 2);
      ctx.lineTo(RIGHT_COL_RIGHT_X, topOffset + 2);
      ctx.stroke();
    }

    ctx.fillStyle = "#111111";
    ctx.font = isBold ? ROW_BOLD_FONT : ROW_REGULAR_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    labelLines.forEach((line, li) =>
      ctx.fillText(line, labelX, topOffset + ROW_BASE_PAD_Y + li * LINE_HEIGHT),
    );

    if (row.kind === "number") {
      const textY =
        topOffset + ROW_BASE_PAD_Y + (labelLines.length - 1) * LINE_HEIGHT;
      ctx.textAlign = "right";
      if (row.values[0]) ctx.fillText(row.values[0], LEFT_COL_RIGHT_X, textY);
      if (row.values[1]) ctx.fillText(row.values[1], RIGHT_COL_RIGHT_X, textY);

      if (isGrandTotal) {
        const bottomRuleY = topOffset + height - 6;
        ctx.strokeStyle = "#111111";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(LEFT_COL_RIGHT_X - COL_BOX_WIDTH + 16, bottomRuleY);
        ctx.lineTo(RIGHT_COL_RIGHT_X, bottomRuleY);
        ctx.moveTo(LEFT_COL_RIGHT_X - COL_BOX_WIDTH + 16, bottomRuleY + 4);
        ctx.lineTo(RIGHT_COL_RIGHT_X, bottomRuleY + 4);
        ctx.stroke();
      }
    }
  }

  return canvas.toBuffer("image/png");
}

function drawHolidayFixture() {
  const width = 420;
  const height = 260;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Sky
  ctx.fillStyle = "#87ceeb";
  ctx.fillRect(0, 0, width, 150);

  // Sun
  ctx.fillStyle = "#ffd54f";
  ctx.beginPath();
  ctx.arc(340, 56, 32, 0, Math.PI * 2);
  ctx.fill();

  // Sea
  ctx.fillStyle = "#2b7bb9";
  ctx.fillRect(0, 145, width, 55);

  // Sand
  ctx.fillStyle = "#f2d398";
  ctx.fillRect(0, 195, width, 65);

  // Caption
  ctx.fillStyle = "#16324f";
  ctx.font = `700 22px "${FONT_FAMILY}"`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Summer holiday at the beach", 24, 214);

  return canvas.toBuffer("image/png");
}

async function main() {
  registerFonts();
  const outDir = path.join(process.cwd(), "src/fixtures/uploads");
  await mkdir(outDir, { recursive: true });

  const appleRaw = await readFile(
    path.join(process.cwd(), "src/fixtures/apple-statement.json"),
    "utf-8",
  );
  const appleStatement = JSON.parse(appleRaw);

  const statementPng = drawStatementFixture(appleStatement);
  const holidayPng = drawHolidayFixture();

  await writeFile(path.join(outDir, "statement-apple.png"), statementPng);
  await writeFile(path.join(outDir, "holiday-photo.png"), holidayPng);

  console.log(
    `Wrote statement-apple.png (${statementPng.length} bytes) and holiday-photo.png (${holidayPng.length} bytes).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
