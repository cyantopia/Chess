import { NextResponse } from "next/server";
import { heartbeatRoomPlayer } from "@/lib/room-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "home";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const payload = await request.json().catch(() => null);
  const playerId =
    typeof payload?.playerId === "string" ? payload.playerId.trim() : "";
  const instanceId =
    typeof payload?.instanceId === "string" ? payload.instanceId.trim() : "";

  if (!playerId || !instanceId) {
    return NextResponse.json(
      { error: "플레이어 세션 정보가 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await heartbeatRoomPlayer({
        code,
        playerId,
        instanceId,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "플레이어 상태를 갱신하지 못했습니다.",
      },
      { status: 400 },
    );
  }
}
