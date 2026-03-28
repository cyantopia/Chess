import { NextResponse } from "next/server";
import { createRoom } from "@/lib/room-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "home";

export async function POST(request: Request) {
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
    return NextResponse.json(await createRoom(playerName, instanceId));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "방을 생성하지 못했습니다.",
      },
      { status: 500 },
    );
  }
}
