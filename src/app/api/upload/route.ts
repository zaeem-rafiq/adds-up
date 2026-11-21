import { NextRequest, NextResponse } from "next/server";
import {
  getGlobalUploadStore,
  validateUploadBuffer,
} from "@/lib/uploads";
import { MAX_UPLOAD_BYTES, OVERSIZE_REFUSAL_MESSAGE } from "@/lib/upload-validation";

export async function POST(request: NextRequest) {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    // Allow small multipart header overhead above 8 MB, reject clearly huge bodies early.
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES + 256 * 1024) {
      return NextResponse.json(
        { code: "too_large", error: OVERSIZE_REFUSAL_MESSAGE },
        { status: 413 },
      );
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      {
        code: "invalid_request",
        error: "Could not read the uploaded file. Upload a PNG or JPEG picture.",
      },
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

  const arrayBuffer = await fileEntry.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

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

  const store = getGlobalUploadStore();
  const record = store.create({
    fileName: check.fileName,
    mimeType: check.mimeType,
    buffer,
  });

  return NextResponse.json(
    {
      id: record.id,
      fileName: record.fileName,
      mimeType: record.mimeType,
    },
    { status: 201 },
  );
}
