import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { POST as postUpload } from "@/app/api/upload/route";
import { resetGlobalRateLimiter } from "@/lib/rate-limit";
import { getGlobalUploadStore, resetGlobalUploadStore } from "@/lib/uploads";
import {
  jpegWithSize,
  PNG_SIGNATURE,
  pngWithSize,
} from "@/lib/upload-test-pictures";
import {
  MAX_UPLOAD_BYTES,
  OVERSIZE_REFUSAL_MESSAGE,
} from "@/lib/upload-validation";

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

const EIGHT_MB = 8 * 1024 * 1024;

function uploadRequest(
  file: Uint8Array,
  options: { name?: string; type?: string; ip?: string } = {},
): NextRequest {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(file)], options.name ?? "statement.png", {
      type: options.type ?? "image/png",
    }),
  );
  return new NextRequest("http://localhost/api/upload", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": options.ip ?? "203.0.113.120" },
  });
}

async function realPng(): Promise<Buffer> {
  return readFile(
    path.join(process.cwd(), "src/fixtures/uploads/statement-apple.png"),
  );
}

beforeEach(() => {
  resetGlobalRateLimiter();
  resetGlobalUploadStore();
});

afterEach(() => {
  resetGlobalRateLimiter();
  resetGlobalUploadStore();
});

describe("POST /api/upload size limits", () => {
  test("the limit is 8 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(EIGHT_MB);
  });

  test("refuses a declared content-length over 8 MB before the body is read", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body,
      duplex: "half",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(EIGHT_MB + 1),
        "x-forwarded-for": "203.0.113.121",
      },
    } as NextRequestInit);

    const response = await postUpload(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "too_large",
      error: OVERSIZE_REFUSAL_MESSAGE,
    });
    expect(pulls).toBe(0);
    expect(getGlobalUploadStore().size).toBe(0);
  });

  test("stops reading a body with no content-length once it grows past 8 MB", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          // 100 chunks of 1 MB would be 100 MB if every one were read.
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (pulls >= 100) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const request = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body,
      duplex: "half",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "x-forwarded-for": "203.0.113.122",
      },
    } as NextRequestInit);

    const response = await postUpload(request);
    expect(response.status).toBe(413);
    expect(pulls).toBeLessThan(15);
    expect(cancelled).toBe(true);
  });

  test("a body whose content-length is smaller than the truth is still cut off", async () => {
    const big = new Uint8Array(EIGHT_MB + 1024);
    const request = new NextRequest("http://localhost/api/upload", {
      method: "POST",
      body: big,
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": "100",
        "x-forwarded-for": "203.0.113.123",
      },
    });
    const response = await postUpload(request);
    expect(response.status).toBe(413);
  });
});

describe("POST /api/upload keeps only real PNG and JPEG pictures", () => {
  test("accepts a real PNG and stores it under a random id", async () => {
    const response = await postUpload(uploadRequest(await realPng()));
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { id: string; mimeType: string };
    expect(payload.mimeType).toBe("image/png");
    expect(getGlobalUploadStore().get(payload.id)?.buffer.length).toBeGreaterThan(1000);
  });

  test("the first bytes decide the type, whatever the name and header say", async () => {
    // JPEG bytes sent as a .png file with a png header: kept as a JPEG.
    const jpeg = await postUpload(
      uploadRequest(jpegWithSize(800, 600), { name: "scan.png", type: "image/png" }),
    );
    expect(jpeg.status).toBe(201);
    expect(((await jpeg.json()) as { mimeType: string }).mimeType).toBe("image/jpeg");

    // Text sent as a PNG.
    const text = await postUpload(
      uploadRequest(Buffer.from("<html>not a picture</html>"), {
        name: "statement.png",
        type: "image/png",
      }),
    );
    expect(text.status).toBe(400);
    expect(((await text.json()) as { code: string }).code).toBe("unsupported_type");

    // A PDF sent as a JPEG.
    const pdf = await postUpload(
      uploadRequest(Buffer.from("%PDF-1.7\n1 0 obj\n"), {
        name: "statement.jpg",
        type: "image/jpeg",
      }),
    );
    expect(pdf.status).toBe(400);
    expect(((await pdf.json()) as { code: string }).code).toBe("pdf");

    // A GIF and a WebP are not PNG or JPEG.
    for (const bytes of [
      Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1"),
      Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1"),
    ]) {
      const other = await postUpload(
        uploadRequest(bytes, { name: "picture.png", type: "image/png" }),
      );
      expect(other.status).toBe(400);
    }
    expect(getGlobalUploadStore().size).toBe(1);
  });

  test("refuses a request that is not a multipart form, or has no file", async () => {
    const notMultipart = await postUpload(
      new NextRequest("http://localhost/api/upload", {
        method: "POST",
        body: JSON.stringify({ file: "x" }),
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.124",
        },
      }),
    );
    expect(notMultipart.status).toBe(400);

    const form = new FormData();
    form.set("other", "value");
    const noFile = await postUpload(
      new NextRequest("http://localhost/api/upload", {
        method: "POST",
        body: form,
        headers: { "x-forwarded-for": "203.0.113.124" },
      }),
    );
    expect(noFile.status).toBe(400);
    expect(((await noFile.json()) as { code: string }).code).toBe("missing_file");
  });
});

describe("POST /api/upload picture size", () => {
  test("accepts a picture 6,000 pixels wide and tall", async () => {
    const response = await postUpload(uploadRequest(pngWithSize(6000, 6000)));
    expect(response.status).toBe(201);
  });

  test("refuses a picture wider or taller than 6,000 pixels with a plain message", async () => {
    for (const picture of [
      uploadRequest(pngWithSize(6001, 100)),
      uploadRequest(pngWithSize(100, 6001)),
      uploadRequest(jpegWithSize(9000, 100), { name: "wide.jpg", type: "image/jpeg" }),
    ]) {
      const response = await postUpload(picture);
      expect(response.status).toBe(413);
      const payload = (await response.json()) as { code: string; error: string };
      expect(payload.code).toBe("dimensions");
      expect(payload.error).toContain("6,000 pixels");
    }
    expect(getGlobalUploadStore().size).toBe(0);
  });

  test("refuses a PNG signature with no readable size", async () => {
    const response = await postUpload(uploadRequest(PNG_SIGNATURE));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("unreadable");
  });
});

describe("POST /api/upload rate limit", () => {
  test("allows 20 uploads per address in one hour and refuses the 21st before reading it", async () => {
    for (let i = 0; i < 20; i += 1) {
      const response = await postUpload(
        uploadRequest(pngWithSize(100, 100), { ip: "203.0.113.130" }),
      );
      expect(response.status).toBe(201);
    }

    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const refused = await postUpload(
      new NextRequest("http://localhost/api/upload", {
        method: "POST",
        body,
        duplex: "half",
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "x-forwarded-for": "203.0.113.130",
        },
      } as NextRequestInit),
    );
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { code: string }).code).toBe("rate_limit");
    expect(pulls).toBe(0);

    // Another address is not affected.
    const other = await postUpload(
      uploadRequest(pngWithSize(100, 100), { ip: "203.0.113.131" }),
    );
    expect(other.status).toBe(201);
  });

  test("refused and invalid attempts count against the 20 too", async () => {
    for (let i = 0; i < 20; i += 1) {
      const response = await postUpload(
        uploadRequest(Buffer.from("not a picture"), { ip: "203.0.113.132" }),
      );
      expect(response.status).toBe(400);
    }
    const next = await postUpload(
      uploadRequest(pngWithSize(100, 100), { ip: "203.0.113.132" }),
    );
    expect(next.status).toBe(429);
  });
});
