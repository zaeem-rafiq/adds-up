import { afterEach, describe, expect, test } from "vitest";
import {
  DEFAULT_RATE_LIMITS,
  extractClientIp,
  getGlobalRateLimiter,
  getRateLimitConfig,
  RateLimiter,
  RateLimitError,
  resetGlobalRateLimiter,
  UNKNOWN_ADDRESS,
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

describe("Network address counting (hardening point 1)", () => {
  function headersWith(values: Record<string, string>): Headers {
    return new Headers(values);
  }

  test("uses the first x-forwarded-for entry and nothing else", () => {
    expect(
      extractClientIp(
        headersWith({ "x-forwarded-for": "203.0.113.7, 10.0.0.2, 10.0.0.3" }),
      ),
    ).toBe("203.0.113.7");
    expect(
      extractClientIp(headersWith({ "x-forwarded-for": "  198.51.100.4  " })),
    ).toBe("198.51.100.4");
  });

  test("ignores x-real-ip, which a visitor can set to anything", () => {
    expect(extractClientIp(headersWith({ "x-real-ip": "203.0.113.9" }))).toBe(
      UNKNOWN_ADDRESS,
    );
    expect(
      extractClientIp(
        headersWith({
          "x-forwarded-for": "203.0.113.7",
          "x-real-ip": "203.0.113.99",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  test("falls back to one fixed bucket when the header is missing, empty or not an address", () => {
    expect(extractClientIp(new Headers())).toBe(UNKNOWN_ADDRESS);
    expect(extractClientIp(headersWith({ "x-forwarded-for": "" }))).toBe(
      UNKNOWN_ADDRESS,
    );
    expect(extractClientIp(headersWith({ "x-forwarded-for": ", 1.2.3.4" }))).toBe(
      UNKNOWN_ADDRESS,
    );
    expect(
      extractClientIp(headersWith({ "x-forwarded-for": "not-an-address" })),
    ).toBe(UNKNOWN_ADDRESS);
    expect(
      extractClientIp(headersWith({ "x-forwarded-for": "x".repeat(500) })),
    ).toBe(UNKNOWN_ADDRESS);
  });

  test("strips a port, and counts an IPv6 visitor by its /64 block", () => {
    expect(
      extractClientIp(headersWith({ "x-forwarded-for": "203.0.113.7:51234" })),
    ).toBe("203.0.113.7");
    const a = extractClientIp(
      headersWith({ "x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd" }),
    );
    const b = extractClientIp(
      headersWith({ "x-forwarded-for": "2001:db8:1:2::1" }),
    );
    const other = extractClientIp(
      headersWith({ "x-forwarded-for": "2001:db8:1:3::1" }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(
      extractClientIp(headersWith({ "x-forwarded-for": "::ffff:203.0.113.8" })),
    ).toBe("203.0.113.8");
  });

  // A whole venue shares one network address, so a new browser is held to the address limit,
  // not to the lower per-browser limit. Dropping the cookie therefore gains nothing past it.
  test("a visitor who drops the cookie is still held to the limit for the address", () => {
    const now = 1_700_000_000_000;
    const limiter = new RateLimiter({
      now: () => now,
      limits: { browserPerHour: 2, ipPerHour: 3 },
    });
    const ip = "203.0.113.50";

    // Every request carries a brand-new browser id, as if the cookie was dropped.
    for (let i = 0; i < 3; i += 1) {
      expect(
        limiter.checkAndConsumeRequest({ browserId: `dropped-cookie-${i}-aaaaaaaa`, ip })
          .allowed,
      ).toBe(true);
    }
    const fourth = limiter.checkAndConsumeRequest({
      browserId: "dropped-cookie-3-aaaaaaaa",
      ip,
    });
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) expect(fourth.reason).toBe("ip");

    // Another address is not affected.
    expect(
      limiter.checkAndConsumeRequest({
        browserId: "dropped-cookie-4-aaaaaaaa",
        ip: "203.0.113.51",
      }).allowed,
    ).toBe(true);
  });

  test("keeps the cookie count: one browser id is still limited on its own", () => {
    const now = 1_700_000_000_000;
    const limiter = new RateLimiter({
      now: () => now,
      limits: { browserPerHour: 2 },
    });
    const params = { browserId: "returning-browser-aaaa", ip: "203.0.113.60" };
    expect(limiter.checkAndConsumeRequest(params).allowed).toBe(true);
    expect(limiter.checkAndConsumeRequest(params).allowed).toBe(true);
    const third = limiter.checkAndConsumeRequest(params);
    expect(third.allowed).toBe(false);
    if (!third.allowed) expect(third.reason).toBe("browser");
  });

  test("counts every request by address, with or without a cookie", () => {
    const now = 1_700_000_000_000;
    const limiter = new RateLimiter({ now: () => now });
    const ip = "203.0.113.70";
    limiter.checkAndConsumeRequest({ browserId: "cookie-one-aaaaaaaaaa", ip });
    limiter.checkAndConsumeRequest({ browserId: "cookie-one-aaaaaaaaaa", ip });
    limiter.checkAndConsumeRequest({ browserId: "cookie-two-aaaaaaaaaa", ip });
    expect(
      limiter.getCounts({ browserId: "cookie-one-aaaaaaaaaa", ip }),
    ).toMatchObject({ browserHourCount: 2, ipHourCount: 3 });
  });

  test("a browser that comes back after an hour counts as new once, then as itself", () => {
    let now = 1_700_000_000_000;
    const limiter = new RateLimiter({
      now: () => now,
      limits: { browserPerHour: 2 },
    });
    const params = { browserId: "slow-returning-browser", ip: "203.0.113.80" };
    expect(limiter.checkAndConsumeRequest(params).allowed).toBe(true);
    now += 61 * 60 * 1000;
    expect(limiter.checkAndConsumeRequest(params).allowed).toBe(true);
    expect(limiter.checkAndConsumeRequest(params).allowed).toBe(true);
    expect(limiter.checkAndConsumeRequest(params).allowed).toBe(false);
  });

  test("reserveModelCall counts one call and throws a daily RateLimitError at the cap", () => {
    const now = 1_700_000_000_000;
    const limiter = new RateLimiter({
      now: () => now,
      limits: { globalModelCallsPerDay: 2 },
    });
    limiter.reserveModelCall();
    limiter.reserveModelCall();
    expect(limiter.getCounts({ browserId: "x", ip: "y" }).dailyModelCalls).toBe(2);
    let caught: unknown;
    try {
      limiter.reserveModelCall();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).reason).toBe("daily");
    expect(limiter.getCounts({ browserId: "x", ip: "y" }).dailyModelCalls).toBe(2);
  });

  test("allows 20 uploads per address per hour, then refuses, and frees the slot after an hour", () => {
    let now = 1_700_000_000_000;
    const limiter = new RateLimiter({ now: () => now });
    expect(limiter.getLimits().uploadsPerHour).toBe(20);
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.checkAndConsumeUpload("203.0.113.90").allowed).toBe(true);
    }
    const refused = limiter.checkAndConsumeUpload("203.0.113.90");
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.reason).toBe("upload");
      expect(refused.message).toContain("20 uploads");
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(limiter.checkAndConsumeUpload("203.0.113.91").allowed).toBe(true);

    now += 60 * 60 * 1000 + 1;
    expect(limiter.checkAndConsumeUpload("203.0.113.90").allowed).toBe(true);
  });

  test("drops keys that were not used for an hour so the maps cannot grow without end", () => {
    let now = 1_700_000_000_000;
    const limiter = new RateLimiter({
      now: () => now,
      limits: { ipPerHour: 10, browserPerHour: 10 },
    });
    for (let i = 0; i < 5_100; i += 1) {
      limiter.recordRequest({
        browserId: `passing-browser-${i}-aaaaaaaa`,
        ip: `10.${Math.floor(i / 250)}.${i % 250}.1`,
      });
    }
    expect(limiter.trackedKeyCount).toBeGreaterThan(5_000);

    now += 61 * 60 * 1000;
    limiter.recordRequest({ browserId: "fresh-browser-after-sweep", ip: "203.0.113.1" });
    // The three keys of the new request remain; every stale key is gone.
    expect(limiter.trackedKeyCount).toBe(3);
  });
});
