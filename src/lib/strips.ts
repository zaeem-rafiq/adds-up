import type { Statement, StatementRow } from "@/lib/statements";

export const MAX_NUMBER_ROWS_PER_PICTURE = 12;

export function splitStatementIntoStrips(
  statement: Statement,
  maxNumberRows = MAX_NUMBER_ROWS_PER_PICTURE,
): StatementRow[][] {
  const limit = Math.max(1, Math.floor(maxNumberRows));
  const numberRowIndices: number[] = [];

  for (let i = 0; i < statement.rows.length; i += 1) {
    if (statement.rows[i].kind === "number") {
      numberRowIndices.push(i);
    }
  }

  if (numberRowIndices.length <= limit) {
    return [statement.rows];
  }

  const strips: StatementRow[][] = [];
  let startRowIndex = 0;

  for (let n = 0; n < numberRowIndices.length; n += limit) {
    const isLastChunk = n + limit >= numberRowIndices.length;
    if (isLastChunk) {
      strips.push(statement.rows.slice(startRowIndex));
    } else {
      // Split right after the last number row in this chunk so any heading
      // introducing the next section stays with the next strip and no row is cut.
      const endRowIndex = numberRowIndices[n + limit - 1] + 1;
      strips.push(statement.rows.slice(startRowIndex, endRowIndex));
      startRowIndex = endRowIndex;
    }
  }

  return strips;
}

export function countStatementStrips(
  statement: Statement,
  maxNumberRows = MAX_NUMBER_ROWS_PER_PICTURE,
): number {
  return splitStatementIntoStrips(statement, maxNumberRows).length;
}
