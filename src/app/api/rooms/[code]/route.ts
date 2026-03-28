import { NextResponse } from "next/server";
import { getRoomSync, leaveRoom } from "@/lib/room-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "home";

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get("playerId") ?? undefined;
  const instanceId = searchParams.get("instanceId") ?? undefined;

  try {
    return NextResponse.json(
      await getRoomSync({
        code,
        playerId,
        instanceId,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "방을 찾을 수 없습니다.",
      },
      { status: 404 },
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const { searchParams } = new URL(request.url);
  const playerId = searchParams.get("playerId")?.trim() ?? "";

  if (!playerId) {
    return NextResponse.json(
      { error: "세션을 종료할 플레이어 정보가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await leaveRoom(code, playerId));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "세션을 종료하지 못했습니다.",
      },
      { status: 400 },
    );
  }
}
