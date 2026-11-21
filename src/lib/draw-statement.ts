import { existsSync } from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import type { Statement, StatementRow } from "@/lib/statements";

export type CellRef = {
  /** 0-based index into the drawn rows array */
  rowIndex: number;
  /** 0 for left column, 1 for right column */
  colIndex: 0 | 1;
};

export type DrawStatementOptions = {
  /** Cover one cell with a solid black rectangle */
  coverCell?: CellRef;
  /** Replace one cell's printed text with another value */
  overrideCell?: CellRef & { value: string };
  /** Optional subset of rows to draw (defaults to statement.rows) */
  rows?: StatementRow[];
};

export type CellBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RowLayoutBox = {
  rowIndex: number;
  kind: StatementRow["kind"];
  y: number;
  height: number;
  cells: [CellBox, CellBox];
};

export type StatementPictureLayout = {
  width: number;
  height: number;
  leftColRightX: number;
  rightColRightX: number;
  rowBoxes: RowLayoutBox[];
};

const FONT_FAMILY = "AddsUpDejaVu";
const REGULAR_FONT_PATH = path.join(
  process.cwd(),
  "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf",
);
const BOLD_FONT_PATH = path.join(
  process.cwd(),
  "node_modules/dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf",
);

let fontsRegistered = false;

export function ensureStatementFonts(): void {
  if (fontsRegistered && GlobalFonts.has(FONT_FAMILY)) {
    return;
  }

  if (!existsSync(REGULAR_FONT_PATH) || !existsSync(BOLD_FONT_PATH)) {
    throw new Error(
      `Missing DejaVu Sans font files at ${REGULAR_FONT_PATH} and ${BOLD_FONT_PATH}.`,
    );
  }

  const regularKey = GlobalFonts.registerFromPath(
    REGULAR_FONT_PATH,
    FONT_FAMILY,
    { weight: "400", style: "normal" },
  );
  const boldKey = GlobalFonts.registerFromPath(BOLD_FONT_PATH, FONT_FAMILY, {
    weight: "700",
    style: "normal",
  });

  if (!regularKey || !boldKey) {
    throw new Error("Failed to register DejaVu Sans fonts for statement rendering.");
  }

  fontsRegistered = true;
}

function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
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

const TITLE_FONT = `700 24px "${FONT_FAMILY}"`;
const UNIT_FONT = `400 17px "${FONT_FAMILY}"`;
const COL_HEADER_FONT = `700 17px "${FONT_FAMILY}"`;
const ROW_REGULAR_FONT = `400 19px "${FONT_FAMILY}"`;
const ROW_BOLD_FONT = `700 19px "${FONT_FAMILY}"`;

const LINE_HEIGHT = 27;
const ROW_BASE_PAD_Y = 9;

type PreparedRow = {
  rowIndex: number;
  row: StatementRow;
  labelLines: string[];
  topOffset: number;
  height: number;
  isGrandTotal: boolean;
};

export function drawStatementWithLayout(
  statement: Statement,
  options?: DrawStatementOptions,
): { png: Buffer; layout: StatementPictureLayout } {
  ensureStatementFonts();

  const rows = options?.rows ?? statement.rows;
  const measureCanvas = createCanvas(IMAGE_WIDTH, 100);
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.lang = "en";

  // Header height calculations
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
  const col0Lines = statement.columns[0]
    ? wrapText(measureCtx, statement.columns[0], COL_BOX_WIDTH)
    : [""];
  const col1Lines = statement.columns[1]
    ? wrapText(measureCtx, statement.columns[1], COL_BOX_WIDTH)
    : [""];
  const colHeaderLineCount = Math.max(col0Lines.length, col1Lines.length);

  let y = PADDING_TOP;
  const titleY = y;
  y += titleLines.length * 32;

  const unitY = y + 4;
  if (unitLines.length > 0) {
    y += 4 + unitLines.length * 24;
  }

  y += 26;
  const colHeaderY = y;
  y += colHeaderLineCount * 24 + 18;

  // Measure each row
  const prepared: PreparedRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const isBold = row.kind === "heading" || row.isTotal;
    measureCtx.font = isBold ? ROW_BOLD_FONT : ROW_REGULAR_FONT;

    const labelX = PADDING_X + row.indent * INDENT_STEP;
    const maxLabelWidth = Math.max(220, LABEL_RIGHT_LIMIT - labelX);
    const labelLines = wrapText(measureCtx, row.label, maxLabelWidth);

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
      (lower === "total assets" ||
        lower.startsWith("total liabilities and") ||
        i === rows.length - 1);

    const height =
      labelLines.length * LINE_HEIGHT +
      ROW_BASE_PAD_Y * 2 +
      (isGrandTotal ? 8 : 0);

    y += extraTop;
    prepared.push({
      rowIndex: i,
      row,
      labelLines,
      topOffset: y,
      height,
      isGrandTotal,
    });
    y += height;
  }

  const totalHeight = Math.max(240, Math.ceil(y + PADDING_BOTTOM));
  const canvas = createCanvas(IMAGE_WIDTH, totalHeight);
  const ctx = canvas.getContext("2d");
  ctx.lang = "en";

  // White page background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, IMAGE_WIDTH, totalHeight);

  // Title
  ctx.fillStyle = "#111111";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = TITLE_FONT;
  for (let i = 0; i < titleLines.length; i += 1) {
    ctx.fillText(titleLines[i], PADDING_X, titleY + i * 32);
  }

  // Unit line
  if (unitLines.length > 0) {
    ctx.fillStyle = "#333333";
    ctx.font = UNIT_FONT;
    for (let i = 0; i < unitLines.length; i += 1) {
      ctx.fillText(unitLines[i], PADDING_X, unitY + i * 24);
    }
  }

  // Column headings (right-aligned)
  ctx.fillStyle = "#111111";
  ctx.font = COL_HEADER_FONT;
  ctx.textAlign = "right";
  const colHeaderBottom = colHeaderY + colHeaderLineCount * 24;
  for (let i = 0; i < col0Lines.length; i += 1) {
    const lineY =
      colHeaderBottom - (col0Lines.length - i) * 24;
    ctx.fillText(col0Lines[i], LEFT_COL_RIGHT_X, lineY);
  }
  for (let i = 0; i < col1Lines.length; i += 1) {
    const lineY =
      colHeaderBottom - (col1Lines.length - i) * 24;
    ctx.fillText(col1Lines[i], RIGHT_COL_RIGHT_X, lineY);
  }

  // Draw rows
  const rowBoxes: RowLayoutBox[] = [];

  for (const item of prepared) {
    const { row, rowIndex, labelLines, topOffset, height, isGrandTotal } = item;
    const isBold = row.kind === "heading" || row.isTotal;
    const labelX = PADDING_X + row.indent * INDENT_STEP;

    const leftCellBox: CellBox = {
      x: LEFT_COL_RIGHT_X - COL_BOX_WIDTH,
      y: topOffset,
      width: COL_BOX_WIDTH,
      height,
    };
    const rightCellBox: CellBox = {
      x: RIGHT_COL_RIGHT_X - COL_BOX_WIDTH,
      y: topOffset,
      width: COL_BOX_WIDTH,
      height,
    };

    rowBoxes.push({
      rowIndex,
      kind: row.kind,
      y: topOffset,
      height,
      cells: [leftCellBox, rightCellBox],
    });

    // Rule above total rows
    if (row.kind === "number" && row.isTotal) {
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(LEFT_COL_RIGHT_X - COL_BOX_WIDTH + 16, topOffset + 2);
      ctx.lineTo(RIGHT_COL_RIGHT_X, topOffset + 2);
      ctx.stroke();
    }

    // Label text
    ctx.fillStyle = "#111111";
    ctx.font = isBold ? ROW_BOLD_FONT : ROW_REGULAR_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    for (let li = 0; li < labelLines.length; li += 1) {
      ctx.fillText(
        labelLines[li],
        labelX,
        topOffset + ROW_BASE_PAD_Y + li * LINE_HEIGHT,
      );
    }

    // Number columns (aligned with last line of multi-line labels)
    if (row.kind === "number") {
      const textY =
        topOffset + ROW_BASE_PAD_Y + (labelLines.length - 1) * LINE_HEIGHT;
      const colRightXs: [number, number] = [LEFT_COL_RIGHT_X, RIGHT_COL_RIGHT_X];

      for (const colIndex of [0, 1] as const) {
        const isCovered =
          options?.coverCell?.rowIndex === rowIndex &&
          options.coverCell.colIndex === colIndex;

        if (isCovered) {
          const boxWidth = 152;
          const boxHeight = LINE_HEIGHT + 4;
          ctx.fillStyle = "#000000";
          ctx.fillRect(
            colRightXs[colIndex] - boxWidth,
            textY - 4,
            boxWidth + 4,
            boxHeight,
          );
          continue;
        }

        const isOverridden =
          options?.overrideCell?.rowIndex === rowIndex &&
          options.overrideCell.colIndex === colIndex;

        const displayText = isOverridden
          ? options.overrideCell!.value
          : row.values[colIndex];

        if (displayText) {
          ctx.fillStyle = "#111111";
          ctx.font = isBold ? ROW_BOLD_FONT : ROW_REGULAR_FONT;
          ctx.textAlign = "right";
          ctx.textBaseline = "top";
          ctx.fillText(displayText, colRightXs[colIndex], textY);
        }
      }

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

  return {
    png: canvas.toBuffer("image/png"),
    layout: {
      width: IMAGE_WIDTH,
      height: totalHeight,
      leftColRightX: LEFT_COL_RIGHT_X,
      rightColRightX: RIGHT_COL_RIGHT_X,
      rowBoxes,
    },
  };
}

export function drawStatementPng(
  statement: Statement,
  options?: DrawStatementOptions,
): Buffer {
  return drawStatementWithLayout(statement, options).png;
}
