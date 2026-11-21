import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_RATE_LIMITS,
  getGlobalRateLimiter,
  getRateLimitConfig,
  RateLimiter,
  resetGlobalRateLimiter,
} from "./rate-limit";

describe("Rate limit settings (unit 6a)", () => {
  const originalEnv = {
    browser: process.env.ADDS_UP_LIMIT_BROWSER_PER_HOUR,
    address: process.env.ADDS_UP_LIMIT_ADDRESS_PER_HOUR,
    calls: process.env.ADDS_UP_LIMIT_CALLS_PER_DAY,
  };

  afterEach(() => {
    if (originalEnv.browser === undefined) {
      delete process.env.ADDS_UP_LIMIT_BROWSER_PER_HOUR;
    } else {
      process.env.ADDS_UP_LIMIT_BROWSER_PER_HOUR = originalEnv.browser;
    }
    if (originalEnv.address === undefined) {
      delete process.env.ADDS_UP_LIMIT_ADDRESS_PER_HOUR;
    } else {
      process.env.ADDS_UP_LIMIT_ADDRESS_PER_HOUR = originalEnv.address;
    }
    if (originalEnv.calls === undefined) {
      delete process.env.ADDS_UP_LIMIT_CALLS_PER_DAY;
    } else {
      process.env.ADDS_UP_LIMIT_CALLS_PER_DAY = originalEnv.calls;
    }
    resetGlobalRateLimiter();
  });

  test("uses default limits (120, 600, 3000) when settings are unset or invalid", () => {
    delete process.env.ADDS_UP_LIMIT_BROWSER_PER_HOUR;
    delete process.env.ADDS_UP_LIMIT_ADDRESS_PER_HOUR;
    delete process.env.ADDS_UP_LIMIT_CALLS_PER_DAY;

    expect(getRateLimitConfig()).toEqual(DEFAULT_RATE_LIMITS);

    process.env.ADDS_UP_LIMIT_BROWSER_PER_HOUR = "0";
    process.env.ADDS_UP_LIMIT_ADDRESS_PER_HOUR = "-5";
    process.env.ADDS_UP_LIMIT_CALLS_PER_DAY = "abc";

    expect(getRateLimitConfig()).toEqual(DEFAULT_RATE_LIMITS);
  });

  test("honors ADDS_UP_LIMIT_BROWSER_PER_HOUR setting", () => {
    process.env.ADDS_UP_LIMIT_BROWSER_PER_HOUR = "3";
    const now = 1_700_000_000_000;
    const limiter = new RateLimiter({ now: () => now });
    expect(limiter.getLimits().browserPerHour).toBe(3);

    for (let i = 0; i < 3; i += 1) {
      expect(
        limiter.checkAndConsumeRequest({
          browserId: "browser-setting-test-1",
          ip: "198.51.100.1",
        }).allowed,
      ).toBe(true);
    }

    const fourth = limiter.checkAndConsumeRequest({
      browserId: "browser-setting-test-1",
      ip: "198.51.100.1",
    });
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      expect(fourth.reason).toBe("browser");
      expect(fourth.message).toContain("3 readings");
    }
  });

  test("honors ADDS_UP_LIMIT_ADDRESS_PER_HOUR setting", () => {
    process.env.ADDS_UP_LIMIT_ADDRESS_PER_HOUR = "4";
    const now = 1_700_000_000_000;
    const limiter = new RateLimiter({ now: () => now });
    expect(limiter.getLimits().ipPerHour).toBe(4);

    for (let i = 0; i < 4; i += 1) {
      expect(
        limiter.checkAndConsumeRequest({
          browserId: `browser-ip-setting-${String(i).padStart(4, "0")}`,
          ip: "203.0.113.42",
        }).allowed,
      ).toBe(true);
    }

    const fifth = limiter.checkAndConsumeRequest({
      browserId: "browser-ip-setting-9999",
      ip: "203.0.113.42",
    });
    expect(fifth.allowed).toBe(false);
    if (!fifth.allowed) {
      expect(fifth.reason).toBe("ip");
      expect(fifth.message).toContain("4 readings");
    }
  });

  test("honors ADDS_UP_LIMIT_CALLS_PER_DAY setting", () => {
    process.env.ADDS_UP_LIMIT_CALLS_PER_DAY = "5";
    resetGlobalRateLimiter();
    const limiter = getGlobalRateLimiter();
    expect(limiter.getLimits().globalModelCallsPerDay).toBe(5);

    limiter.recordModelCalls(4);
    expect(
      limiter.check({
        browserId: "browser-daily-setting-1",
        ip: "198.51.100.9",
        plannedModelCalls: 1,
      }).allowed,
    ).toBe(true);

    const over = limiter.check({
      browserId: "browser-daily-setting-1",
      ip: "198.51.100.9",
      plannedModelCalls: 2,
    });
    expect(over.allowed).toBe(false);
    if (!over.allowed) {
      expect(over.reason).toBe("daily");
      expect(over.message).toContain("5 model calls");
    }
  });
});
