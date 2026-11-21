import { formatStatementRowsAsReply } from "@/lib/gemini";
import {
  compareReadingWithStatement,
  parseReadingReply,
  type ReadingProgressEvent,
  type ReadRow,
  type StatementReadingResult,
} from "@/lib/reading";
import type { StatementRow } from "@/lib/statements";

export { compareReadingWithStatement };
export type { ReadingProgressEvent, StatementReadingResult };

export function formatStatementRowsAsReplyForTest(
  rows: StatementRow[],
): ReadRow[] {
  return parseReadingReply(formatStatementRowsAsReply(rows));
}
