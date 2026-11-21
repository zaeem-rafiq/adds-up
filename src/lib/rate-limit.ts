import { randomUUID } from "node:crypto";

export const BROWSER_COOKIE_NAME = "adds_up_browser";

export type RateLimitConfig = {
  browserPerHour: number;
  ipPerHour: number;
  globalModelCallsPerDay: number;
  hourWindowMs: number;
  dayWindowMs: number;
};

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  browserPerHour: 120,
  ipPerHour: 600,
  globalModelCallsPerDay: 3_000,
  hourWindowMs: 60 * 60 * 1000,
  dayWindowMs: 24 * 60 * 60 * 1000,
};

export type RateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "browser" | "ip" | "daily";
      message: string;
      retryAfterSeconds: number;
    };

export class RateLimitError extends Error {
  readonly reason: "browser" | "ip" | "daily";
  readonly retryAfterSeconds: number;

  constructor(
    message: string,
    reason: "browser" | "ip" | "daily",
    retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "RateLimitError";
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function pruneWindow(timestamps: number[], cutoff: number): number[] {
  if (timestamps.length === 0 || timestamps[0] > cutoff) {
    return timestamps;
  }
  let firstValid = 0;
  while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) {
    firstValid += 1;
  }
  return firstValid === 0 ? timestamps : timestamps.slice(firstValid);
}

function retryAfter(oldestTimestamp: number | undefined, windowMs: number, now: number): number {
  if (oldestTimestamp === undefined) return 60;
  return Math.max(1, Math.ceil((oldestTimestamp + windowMs - now) / 1000));
}

export class RateLimiter {
  private readonly limits: RateLimitConfig;
  private readonly now: () => number;
  private readonly browserRequests = new Map<string, number[]>();
  private readonly ipRequests = new Map<string, number[]>();
  private dailyModelCalls: number[] = [];

  constructor(options?: {
    limits?: Partial<RateLimitConfig>;
    now?: () => number;
  }) {
    this.limits = { ...DEFAULT_RATE_LIMITS, ...options?.limits };
    this.now = options?.now ?? (() => Date.now());
  }

  private getWindow(map: Map<string, number[]>, key: string, cutoff: number): number[] {
    const existing = map.get(key);
    if (!existing) return [];
    const pruned = pruneWindow(existing, cutoff);
    if (pruned.length === 0) {
      map.delete(key);
    } else if (pruned !== existing) {
      map.set(key, pruned);
    }
    return pruned;
  }

  check(params: {
    browserId: string;
    ip: string;
    plannedModelCalls?: number;
  }): RateLimitDecision {
    const now = this.now();
    const hourCutoff = now - this.limits.hourWindowMs;
    const dayCutoff = now - this.limits.dayWindowMs;
    const planned = Math.max(1, params.plannedModelCalls ?? 1);

    this.dailyModelCalls = pruneWindow(this.dailyModelCalls, dayCutoff);
    if (this.dailyModelCalls.length + planned > this.limits.globalModelCallsPerDay) {
      return {
        allowed: false,
        reason: "daily",
        message:
          "Adds Up has reached its daily limit of 3,000 model calls. Please try again tomorrow.",
        retryAfterSeconds: retryAfter(
          this.dailyModelCalls[0],
          this.limits.dayWindowMs,
          now,
        ),
      };
    }

    const browserHits = this.getWindow(
      this.browserRequests,
      params.browserId,
      hourCutoff,
    );
    if (browserHits.length >= this.limits.browserPerHour) {
      return {
        allowed: false,
        reason: "browser",
        message:
          "You have reached the hourly limit of 120 readings for this browser. Please try again later.",
        retryAfterSeconds: retryAfter(
          browserHits[0],
          this.limits.hourWindowMs,
          now,
        ),
      };
    }

    const ipHits = this.getWindow(this.ipRequests, params.ip, hourCutoff);
    if (ipHits.length >= this.limits.ipPerHour) {
      return {
        allowed: false,
        reason: "ip",
        message:
          "This network address has reached the hourly limit of 600 readings. Please try again later.",
        retryAfterSeconds: retryAfter(ipHits[0], this.limits.hourWindowMs, now),
      };
    }

    return { allowed: true };
  }

  recordRequest(params: { browserId: string; ip: string }): void {
    const now = this.now();
    const hourCutoff = now - this.limits.hourWindowMs;

    const browserHits = this.getWindow(
      this.browserRequests,
      params.browserId,
      hourCutoff,
    );
    browserHits.push(now);
    this.browserRequests.set(params.browserId, browserHits);

    const ipHits = this.getWindow(this.ipRequests, params.ip, hourCutoff);
    ipHits.push(now);
    this.ipRequests.set(params.ip, ipHits);
  }

  recordModelCalls(count = 1): void {
    const now = this.now();
    const dayCutoff = now - this.limits.dayWindowMs;
    this.dailyModelCalls = pruneWindow(this.dailyModelCalls, dayCutoff);
    for (let i = 0; i < count; i += 1) {
      this.dailyModelCalls.push(now);
    }
  }

  checkAndConsumeRequest(params: {
    browserId: string;
    ip: string;
    plannedModelCalls?: number;
  }): RateLimitDecision {
    const decision = this.check(params);
    if (!decision.allowed) {
      return decision;
    }
    this.recordRequest(params);
    return decision;
  }

  getCounts(params: { browserId: string; ip: string }): {
    browserHourCount: number;
    ipHourCount: number;
    dailyModelCalls: number;
  } {
    const now = this.now();
    const hourCutoff = now - this.limits.hourWindowMs;
    const dayCutoff = now - this.limits.dayWindowMs;
    this.dailyModelCalls = pruneWindow(this.dailyModelCalls, dayCutoff);
    return {
      browserHourCount: this.getWindow(
        this.browserRequests,
        params.browserId,
        hourCutoff,
      ).length,
      ipHourCount: this.getWindow(this.ipRequests, params.ip, hourCutoff).length,
      dailyModelCalls: this.dailyModelCalls.length,
    };
  }

  reset(): void {
    this.browserRequests.clear();
    this.ipRequests.clear();
    this.dailyModelCalls = [];
  }
}

const BROWSER_ID_PATTERN = /^[a-zA-Z0-9_-]{16,64}$/;

export function getOrCreateBrowserId(cookieValue?: string): {
  browserId: string;
  isNew: boolean;
} {
  const trimmed = cookieValue?.trim();
  if (trimmed && BROWSER_ID_PATTERN.test(trimmed)) {
    return { browserId: trimmed, isNew: false };
  }
  return { browserId: randomUUID(), isNew: true };
}

export function extractClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

const globalForRateLimit = globalThis as typeof globalThis & {
  __addsUpRateLimiter?: RateLimiter;
};

export function getGlobalRateLimiter(): RateLimiter {
  if (!globalForRateLimit.__addsUpRateLimiter) {
    globalForRateLimit.__addsUpRateLimiter = new RateLimiter();
  }
  return globalForRateLimit.__addsUpRateLimiter;
}
