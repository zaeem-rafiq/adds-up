import { NextRequest, NextResponse } from "next/server";
import { getGlobalUploadStore } from "@/lib/uploads";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/upload/[id]/picture">,
) {
  const { id } = await context.params;
  const store = getGlobalUploadStore();
  const record = store.get(id);

  if (!record) {
    return NextResponse.json(
      { error: "This uploaded statement is no longer in memory." },
      { status: 404 },
    );
  }

  const modKey = request.nextUrl.searchParams.get("mod")?.trim();
  if (modKey) {
    const modPng = record.modifiedPictures.get(modKey);
    if (modPng) {
      return new NextResponse(new Uint8Array(modPng), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  return new NextResponse(new Uint8Array(record.buffer), {
    status: 200,
    headers: {
      "Content-Type": record.mimeType,
      "Cache-Control": "no-store",
    },
  });
}
