export type SecondReaderCutoffs = {
  upper: number | null;
  lower: number | null;
};

export type SecondReaderVerdict = "agrees" | "unsure" | "disagrees";

export type SecondReaderCellResult = {
  /** 0-based index among statement number rows */
  rowIndex: number;
  /** 0 for left column, 1 for right column */
  colIndex: 0 | 1;
  /** Probability P(yes) in [0, 1], or null if the request failed */
  probability: number | null;
  verdict: SecondReaderVerdict;
  failed: boolean;
};

export type SecondReaderResult = {
  results: SecondReaderCellResult[];
  cutoffs: SecondReaderCutoffs;
  modelCalls: number;
  fromCache: boolean;
  failedBatches: number;
  rateLimited: boolean;
};

export function secondReaderCellKey(rowIndex: number, colIndex: 0 | 1): string {
  return `${rowIndex}-${colIndex}`;
}
