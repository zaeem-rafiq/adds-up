import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

export const BROWSER_COOKIE_NAME = "adds_up_browser";

/** The one shared bucket for a request that carries no usable network address. */
export const UNKNOWN_ADDRESS = "unknown";

export type RateLimitReason = "browser" | "ip" | "daily" | "upload";

export type RateLimitConfig = {
  browserPerHour: number;
  ipPerHour: number;
  globalModelCallsPerDay: number;
  uploadsPerHour: number;
  hourWindowMs: number;
  dayWindowMs: number;
};

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  browserPerHour: 120,
  ipPerHour: 600,
  globalModelCallsPerDay: 3_000,
  // A venue or an office shares one address, so this is well above one person's use.
  uploadsPerHour: 60,
  hourWindowMs: 60 * 60 * 1000,
  dayWindowMs: 24 * 60 * 60 * 1000,
};

function parsePositiveIntSetting(
  raw: string | undefined,
  fallback: number,
): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function getRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): RateLimitConfig {
  return {
    ...DEFAULT_RATE_LIMITS,
    browserPerHour: parsePositiveIntSetting(
      env.ADDS_UP_LIMIT_BROWSER_PER_HOUR,
      DEFAULT_RATE_LIMITS.browserPerHour,
    ),
    ipPerHour: parsePositiveIntSetting(
      env.ADDS_UP_LIMIT_ADDRESS_PER_HOUR,
      DEFAULT_RATE_LIMITS.ipPerHour,
    ),
    globalModelCallsPerDay: parsePositiveIntSetting(
      env.ADDS_UP_LIMIT_CALLS_PER_DAY,
      DEFAULT_RATE_LIMITS.globalModelCallsPerDay,
    ),
    uploadsPerHour: parsePositiveIntSetting(
      env.ADDS_UP_LIMIT_UPLOADS_PER_HOUR,
      DEFAULT_RATE_LIMITS.uploadsPerHour,
    ),
  };
}

export type RateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: RateLimitReason;
      message: string;
      retryAfterSeconds: number;
    };

export class RateLimitError extends Error {
  readonly reason: RateLimitReason;
  readonly retryAfterSeconds: number;

  constructor(
    message: string,
    reason: RateLimitReason,
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

/** Past this many tracked keys in one map, a sweep drops the keys with no hit in the last hour. */
const SWEEP_AFTER_KEYS = 5_000;
const SWEEP_EVERY_MS = 60_000;

export class RateLimiter {
  private readonly limits: RateLimitConfig;
  private readonly now: () => number;
  private readonly browserRequests = new Map<string, number[]>();
  private readonly ipRequests = new Map<string, number[]>();
  /** Requests per address from a browser that had no earlier hit this hour. */
  private readonly newBrowserRequests = new Map<string, number[]>();
  private readonly uploadRequests = new Map<string, number[]>();
  private dailyModelCalls: number[] = [];
  private lastSweepAt = 0;

  constructor(options?: {
    limits?: Partial<RateLimitConfig>;
    now?: () => number;
  }) {
    this.limits = { ...getRateLimitConfig(), ...options?.limits };
    this.now = options?.now ?? (() => Date.now());
  }

  getLimits(): RateLimitConfig {
    return { ...this.limits };
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

  /**
   * The maps only prune a key when that key is used again, so ids and addresses that
   * never return would stay in memory. Drop every key with no hit in the last hour.
   */
  private sweepStaleKeys(now: number): void {
    const size =
      this.browserRequests.size +
      this.ipRequests.size +
      this.newBrowserRequests.size +
      this.uploadRequests.size;
    if (size <= SWEEP_AFTER_KEYS || now - this.lastSweepAt < SWEEP_EVERY_MS) {
      return;
    }
    this.lastSweepAt = now;
    const hourCutoff = now - this.limits.hourWindowMs;
    for (const map of [
      this.browserRequests,
      this.ipRequests,
      this.newBrowserRequests,
      this.uploadRequests,
    ]) {
      for (const [key, hits] of map) {
        if (hits.length === 0 || hits[hits.length - 1] <= hourCutoff) {
          map.delete(key);
        }
      }
    }
  }

  private dailyRefusal(planned: number, now: number): RateLimitDecision {
    this.dailyModelCalls = pruneWindow(
      this.dailyModelCalls,
      now - this.limits.dayWindowMs,
    );
    if (this.dailyModelCalls.length + planned <= this.limits.globalModelCallsPerDay) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "daily",
      message: `Adds Up has reached its daily limit of ${this.limits.globalModelCallsPerDay.toLocaleString("en-US")} model calls. Please try again tomorrow.`,
      retryAfterSeconds: retryAfter(
        this.dailyModelCalls[0],
        this.limits.dayWindowMs,
        now,
      ),
    };
  }

  check(params: {
    browserId: string;
    ip: string;
    plannedModelCalls?: number;
  }): RateLimitDecision {
    const now = this.now();
    const hourCutoff = now - this.limits.hourWindowMs;
    const planned = Math.max(1, params.plannedModelCalls ?? 1);

    const daily = this.dailyRefusal(planned, now);
    if (!daily.allowed) return daily;

    const browserHits = this.getWindow(
      this.browserRequests,
      params.browserId,
      hourCutoff,
    );
    if (browserHits.length >= this.limits.browserPerHour) {
      return {
        allowed: false,
        reason: "browser",
        message: `You have reached the hourly limit of ${this.limits.browserPerHour.toLocaleString("en-US")} readings for this browser. Please try again later.`,
        retryAfterSeconds: retryAfter(
          browserHits[0],
          this.limits.hourWindowMs,
          now,
        ),
      };
    }

    // A request with no cookie, or with an id this server has not seen this hour, is a
    // new browser. Dropping the cookie or making up ids must not escape the per-browser
    // limit, so new browsers also share that limit per network address.
    if (browserHits.length === 0) {
      const newBrowserHits = this.getWindow(
        this.newBrowserRequests,
        params.ip,
        hourCutoff,
      );
      // A whole venue shares one address, so new browsers get the address limit, not the browser limit.
      if (newBrowserHits.length >= this.limits.ipPerHour) {
        return {
          allowed: false,
          reason: "ip",
          message: `This network address has reached the hourly limit of ${this.limits.ipPerHour.toLocaleString("en-US")} readings. Please try again later.`,
          retryAfterSeconds: retryAfter(
            newBrowserHits[0],
            this.limits.hourWindowMs,
            now,
          ),
        };
      }
    }

    const ipHits = this.getWindow(this.ipRequests, params.ip, hourCutoff);
    if (ipHits.length >= this.limits.ipPerHour) {
      return {
        allowed: false,
        reason: "ip",
        message: `This network address has reached the hourly limit of ${this.limits.ipPerHour.toLocaleString("en-US")} readings. Please try again later.`,
        retryAfterSeconds: retryAfter(ipHits[0], this.limits.hourWindowMs, now),
      };
    }

    return { allowed: true };
  }

  recordRequest(params: { browserId: string; ip: string }): void {
    const now = this.now();
    const hourCutoff = now - this.limits.hourWindowMs;
    this.sweepStaleKeys(now);

    const browserHits = this.getWindow(
      this.browserRequests,
      params.browserId,
      hourCutoff,
    );
    if (browserHits.length === 0) {
      const newBrowserHits = this.getWindow(
        this.newBrowserRequests,
        params.ip,
        hourCutoff,
      );
      newBrowserHits.push(now);
      this.newBrowserRequests.set(params.ip, newBrowserHits);
    }
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

  /**
   * Counts one model call against the daily cap, or throws when the cap is reached.
   * The request-level check cannot see a repeat attempt coming, so every attempt calls this
   * right before it reaches the model. A refused attempt must make no call.
   */
  reserveModelCall(): void {
    const now = this.now();
    const decision = this.dailyRefusal(1, now);
    if (!decision.allowed) {
      throw new RateLimitError(
        decision.message,
        decision.reason,
        decision.retryAfterSeconds,
      );
    }
    this.dailyModelCalls.push(now);
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

  /** Counts one upload attempt for this network address (default 60 an hour). */
  checkAndConsumeUpload(ip: string): RateLimitDecision {
    const now = this.now();
    const hourCutoff = now - this.limits.hourWindowMs;
    this.sweepStaleKeys(now);
    const hits = this.getWindow(this.uploadRequests, ip, hourCutoff);
    if (hits.length >= this.limits.uploadsPerHour) {
      return {
        allowed: false,
        reason: "upload",
        message: `This network address has reached the hourly limit of ${this.limits.uploadsPerHour.toLocaleString("en-US")} uploads. Please try again later.`,
        retryAfterSeconds: retryAfter(hits[0], this.limits.hourWindowMs, now),
      };
    }
    hits.push(now);
    this.uploadRequests.set(ip, hits);
    return { allowed: true };
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

  /** Number of keys held in memory across all counters. Used by tests. */
  get trackedKeyCount(): number {
    return (
      this.browserRequests.size +
      this.ipRequests.size +
      this.newBrowserRequests.size +
      this.uploadRequests.size
    );
  }

  reset(): void {
    this.browserRequests.clear();
    this.ipRequests.clear();
    this.newBrowserRequests.clear();
    this.uploadRequests.clear();
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

/** Keeps the first four groups of an IPv6 address: one visitor owns a whole /64. */
function ipv6Prefix64(address: string): string {
  const [withoutZone] = address.split("%");
  const [headText, tailText] = withoutZone.split("::");
  const head = headText ? headText.split(":") : [];
  const tail = tailText ? tailText.split(":") : [];
  const missing = withoutZone.includes("::")
    ? Math.max(0, 8 - head.length - tail.length)
    : 0;
  const groups = [...head, ...new Array<string>(missing).fill("0"), ...tail].map(
    (group) => Number.parseInt(group, 16).toString(16),
  );
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/**
 * Turns one x-forwarded-for entry into a counting key, or null when it is not an address.
 * IPv4 stays as written. An IPv6 address counts as its /64 block, because one visitor
 * can use every address in it.
 */
export function normalizeAddress(raw: string): string | null {
  let value = raw.trim();
  if (!value || value.length > 64) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  const family = isIP(value.split("%")[0]);
  if (family === 4) return value;
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
    if (mapped && isIP(mapped[1]) === 4) return mapped[1];
    return ipv6Prefix64(value.toLowerCase());
  }
  return null;
}

/**
 * On Render the visitor's address is the first entry of x-forwarded-for. No other header
 * is trusted. A missing or malformed entry falls into one fixed shared bucket.
 */
export function extractClientIp(headers: Headers): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0];
  return (first ? normalizeAddress(first) : null) ?? UNKNOWN_ADDRESS;
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

export function resetGlobalRateLimiter(): void {
  globalForRateLimit.__addsUpRateLimiter = undefined;
}
