import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

function isIgnored(name: string): boolean {
  try {
    // --no-index asks by the rules alone, so the name need not exist.
    execFileSync("git", ["check-ignore", "--no-index", "-q", name], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("Files that hold settings stay out of git", () => {
  test("ignores .env files, *.env files and local.env", () => {
    for (const name of [
      ".env",
      ".env.local",
      "production.env",
      "secrets.env",
      "config/staging.env",
      "local.env",
      "sub/local.env",
    ]) {
      expect(isIgnored(name), name).toBe(true);
    }
  });

  test("keeps .env.example, which holds names only", () => {
    expect(isIgnored(".env.example")).toBe(false);
  });
});
