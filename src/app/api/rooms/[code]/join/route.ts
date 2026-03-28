import { NextResponse } from "next/server";
import { joinRoom } from "@/lib/room-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "home";

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const payload = await request.json().catch(() => null);
  const playerName =
    typeof payload?.playerName === "string" ? payload.playerName.trim() : "";
  const instanceId =
    typeof payload?.instanceId === "string" ? payload.instanceId.trim() : "";

  if (!playerName || !instanceId) {
    return NextResponse.json(
      { error: "플레이어 이름과 세션 식별자가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await joinRoom(code, playerName, instanceId));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "방 참가에 실패했습니다.",
      },
      { status: 400 },
    );
  }
}
