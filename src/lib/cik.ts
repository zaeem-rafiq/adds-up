/**
 * A company's SEC number as it appears in a URL: digits only, at most 10.
 * The proxy and every route and page that takes a "cik" use this one rule.
 * It has no imports, so the proxy can load it alone.
 */
export function isValidCik(value: string): boolean {
  return /^\d{1,10}$/.test(value);
}
