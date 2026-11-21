import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { POST as postModifyRoute } from "@/app/api/company/[cik]/modify/route";
import appleFixture from "@/fixtures/apple-statement.json";
import { GROUP_NOT_IN_BOTH_COLUMNS_REASON } from "@/lib/adding";
import { formatStatementRowsAsReplyForTest } from "@/lib/reading-test-helpers";
import type { ReadRow, ReadingProgressEvent } from "@/lib/reading";
import type { Statement } from "@/lib/statements";

const APPLE_STATEMENT = appleFixture as unknown as Statement;
const APPLE_ROWS = formatStatementRowsAsReplyForTest(APPLE_STATEMENT.rows);

function postModify(body: Record<string, unknown>) {
  const request = new NextRequest("http://localhost/api/company/320193/modify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return postModifyRoute(request, {
    params: Promise.resolve({ cik: "320193" }),
  });
}

/** Apple's reading with the right column's total of current assets changed, so the right column has no group for rows 1 to 7. */
function rowsWithoutRightGroup(): ReadRow[] {
  const rows = structuredClone(APPLE_ROWS);
  const totalIndex = rows.findIndex((row) => row.label === "Total current assets");
  rows[totalIndex].cells[1] = { raw: "999,999", number: 999999, hidden: false };
  return rows;
}

describe("Modify route refuses a number that cannot be rebuilt before any model call (case D7)", () => {
  test("D7 route: hide of a number whose group is missing in the other column answers 400 with the group reason and starts no reading", async () => {
    const response = await postModify({
      action: "hide",
      numberRowIndex: 4,
      colIndex: 0,
      previousRows: rowsWithoutRightGroup(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      code: "cannot_modify",
      error: GROUP_NOT_IN_BOTH_COLUMNS_REASON,
    });
  });

  test("D7 route: change of the same number is refused with the same reason", async () => {
    const response = await postModify({
      action: "change",
      numberRowIndex: 4,
      colIndex: 0,
      newValue: "15,541",
      previousRows: rowsWithoutRightGroup(),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "cannot_modify",
      error: GROUP_NOT_IN_BOTH_COLUMNS_REASON,
    });
  });

  test("a number whose groups exist in both columns still starts the reading", async () => {
    const response = await postModify({
      action: "hide",
      numberRowIndex: 4,
      colIndex: 0,
      previousRows: APPLE_ROWS,
    });

    expect(response.status).toBe(200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReadingProgressEvent);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });
});
