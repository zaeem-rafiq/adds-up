import { NextRequest, NextResponse } from "next/server";
import { logServerError } from "@/lib/public-errors";
import { extractClientIp, getGlobalRateLimiter } from "@/lib/rate-limit";
import { readBodyWithLimit } from "@/lib/request-limits";
import {
  getGlobalUploadStore,
  UploadStoreFullError,
  validateUploadBuffer,
} from "@/lib/uploads";
import {
  checkUploadImageSize,
  MAX_UPLOAD_BYTES,
  OVERSIZE_REFUSAL_MESSAGE,
} from "@/lib/upload-validation";

const INVALID_UPLOAD_MESSAGE =
  "Could not read the uploaded file. Upload a PNG or JPEG picture.";

export async function POST(request: NextRequest) {
  // Count the attempt first, before any of the body is read: 20 uploads per address per hour.
  const ip = extractClientIp(request.headers);
  const uploadDecision = getGlobalRateLimiter().checkAndConsumeUpload(ip);
  if (!uploadDecision.allowed) {
    return NextResponse.json(
      { code: "rate_limit", error: uploadDecision.message },
      {
        status: 429,
        headers: { "Retry-After": String(uploadDecision.retryAfterSeconds) },
      },
    );
  }

  // A declared content-length over 8 MB is refused before the body is touched. A body
  // that grows past 8 MB while it streams in (or that has no content-length) is cut off.
  const body = await readBodyWithLimit(request, MAX_UPLOAD_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      { code: "too_large", error: OVERSIZE_REFUSAL_MESSAGE },
      { status: 413 },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  let formData: FormData;
  try {
    if (!/^multipart\/form-data/i.test(contentType)) {
      throw new Error("not multipart");
    }
    formData = await new Response(Buffer.from(body.bytes), {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    return NextResponse.json(
      { code: "invalid_request", error: INVALID_UPLOAD_MESSAGE },
      { status: 400 },
    );
  }

  const fileEntry = formData.get("file");
  if (!(fileEntry instanceof File)) {
    return NextResponse.json(
      {
        code: "missing_file",
        error: "Choose a PNG or JPEG picture to upload.",
      },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await fileEntry.arrayBuffer());

  // The first bytes decide the type. The file name and the type the browser sent do not.
  const check = validateUploadBuffer(buffer, {
    name: fileEntry.name,
    type: fileEntry.type,
    size: fileEntry.size,
  });

  if (!check.ok) {
    const status = check.code === "too_large" ? 413 : 400;
    return NextResponse.json(
      { code: check.code, error: check.message },
      { status },
    );
  }

  // Read the size from the header bytes. A picture over 6,000 pixels either way is refused.
  const sizeCheck = checkUploadImageSize(buffer, check.mimeType);
  if (!sizeCheck.ok) {
    return NextResponse.json(
      { code: sizeCheck.code, error: sizeCheck.message },
      { status: sizeCheck.code === "dimensions" ? 413 : 400 },
    );
  }

  const store = getGlobalUploadStore();
  let record;
  try {
    record = store.create({
      fileName: check.fileName,
      mimeType: check.mimeType,
      buffer,
    });
  } catch (error) {
    if (error instanceof UploadStoreFullError) {
      return NextResponse.json(
        { code: "too_large", error: OVERSIZE_REFUSAL_MESSAGE },
        { status: 413 },
      );
    }
    logServerError("storing an uploaded picture", error);
    return NextResponse.json(
      {
        code: "invalid_request",
        error: "Could not store the uploaded file. Please try again.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      id: record.id,
      fileName: record.fileName,
      mimeType: record.mimeType,
    },
    { status: 201 },
  );
}
