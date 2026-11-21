import { describe, expect, test } from "vitest";
import {
  buildExplainCauseParams,
  buildLocateCellBoxParams,
  buildReadPictureParams,
  GEMINI_HYDROGEN_MODEL,
  MAX_OUTPUT_TOKENS,
} from "@/lib/gemini";

describe("Every Gemini call that can set an output ceiling sets one", () => {
  const picture = Buffer.from("picture bytes");

  test("reading a picture", () => {
    const params = buildReadPictureParams({
      png: picture,
      prompt: "Read it.",
      mimeType: "image/jpeg",
    });
    expect(params.model).toBe(GEMINI_HYDROGEN_MODEL);
    expect(params.generation_config.max_output_tokens).toBe(MAX_OUTPUT_TOKENS.read);
    expect(params.generation_config.thinking_level).toBe("low");
    expect(params.input[0]).toMatchObject({
      type: "image",
      mime_type: "image/jpeg",
      data: picture.toString("base64"),
    });
    expect(params.input[1]).toEqual({ type: "text", text: "Read it." });
  });

  test("locating a cell", () => {
    const params = buildLocateCellBoxParams({
      image: picture,
      mimeType: "image/png",
      rowLabel: "Inventories",
      colIndex: 0,
      printedValue: "14,541",
    });
    expect(params.model).toBe(GEMINI_HYDROGEN_MODEL);
    expect(params.generation_config.max_output_tokens).toBe(MAX_OUTPUT_TOKENS.locate);
    expect(JSON.stringify(params.input)).toContain("Inventories");
  });

  test("explaining a cause", () => {
    const params = buildExplainCauseParams({
      groupLabel: "Total current assets",
      rows: [{ label: "Cash", value: "10", number: 10 }],
      statedTotal: 20,
      computedSum: 10,
      gap: 10,
      diff: -10,
      model: "some-cause-model",
    });
    expect(params.model).toBe("some-cause-model");
    expect(params.generation_config.max_output_tokens).toBe(MAX_OUTPUT_TOKENS.cause);
  });

  test("the ceilings are positive whole numbers well above a real answer", () => {
    for (const ceiling of Object.values(MAX_OUTPUT_TOKENS)) {
      expect(Number.isInteger(ceiling)).toBe(true);
      expect(ceiling).toBeGreaterThanOrEqual(1024);
    }
  });
});
