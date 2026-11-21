import { CompanyListError } from "@/lib/companies";
import { StatementError } from "@/lib/statements";

/**
 * Plain sentences that are safe to show a visitor. Raw model, SEC and settings error text
 * can name keys, settings or internal addresses, so it goes to the server log and never
 * to the browser.
 */
export const MODEL_FAILED_MESSAGE =
  "A model could not read this picture. Nothing was guessed.";
export const READING_UNAVAILABLE_MESSAGE =
  "Reading is not available right now. Please try again in a little while.";
export const READ_FAILED_MESSAGE =
  "Could not read the balance sheet picture right now.";
export const UPLOAD_READ_FAILED_MESSAGE =
  "Could not read this uploaded picture right now.";
export const MODIFY_FAILED_MESSAGE =
  "Could not read the updated balance sheet picture right now.";
export const STATEMENT_NOT_FOUND_MESSAGE =
  "No balance sheet was found for this company.";
export const STATEMENT_UNAVAILABLE_MESSAGE =
  "Could not load this company's balance sheet right now. Please try again.";
export const COMPANY_LOAD_FAILED_MESSAGE =
  "Could not load the company right now. Please try again.";
export const COMPANY_SEARCH_UNAVAILABLE_MESSAGE =
  "Company search is not available right now. Please try again.";
export const SAVED_COPY_MESSAGE =
  "The SEC did not answer in time, so a saved copy is shown.";

/** Writes the detail of an error to the server log only. */
export function logServerError(where: string, error: unknown): void {
  const detail =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[adds-up] ${where}: ${detail}`);
}

export function publicStatementError(error: unknown): {
  status: number;
  message: string;
} {
  logServerError("loading a balance sheet", error);
  if (error instanceof StatementError && error.status === 404) {
    return { status: 404, message: STATEMENT_NOT_FOUND_MESSAGE };
  }
  const status =
    error instanceof StatementError && error.status >= 500 ? error.status : 502;
  return { status, message: STATEMENT_UNAVAILABLE_MESSAGE };
}

export function publicCompanyListError(error: unknown): {
  status: number;
  message: string;
} {
  logServerError("loading the company list", error);
  const status =
    error instanceof CompanyListError && error.status >= 500
      ? error.status
      : 503;
  return { status, message: COMPANY_SEARCH_UNAVAILABLE_MESSAGE };
}
