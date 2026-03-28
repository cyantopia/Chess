import { NextResponse } from "next/server";
import { postRoomSignal } from "@/lib/room-store";

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
  const targetId =
    typeof payload?.targetId === "string" ? payload.targetId.trim() : "";
  const targetInstanceId =
    typeof payload?.targetInstanceId === "string"
      ? payload.targetInstanceId.trim()
      : null;
  const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "";

  if (!playerId || !targetId) {
    return NextResponse.json(
      { error: "신호를 보낼 플레이어 정보가 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    if (kind === "offer" || kind === "answer") {
      if (
        typeof payload?.description !== "object" ||
        payload.description === null ||
        typeof payload.description.type !== "string"
      ) {
        return NextResponse.json(
          { error: "세션 설명 정보가 올바르지 않습니다." },
          { status: 400 },
        );
      }

      return NextResponse.json(
        await postRoomSignal({
          code,
          playerId,
          targetId,
          targetInstanceId,
          signal: {
            kind,
            description: {
              type: payload.description.type,
              sdp:
                typeof payload.description.sdp === "string"
                  ? payload.description.sdp
                  : "",
            },
          },
        }),
      );
    }

    if (kind === "ice") {
      if (
        typeof payload?.candidate !== "object" ||
        payload.candidate === null ||
        typeof payload.candidate.candidate !== "string"
      ) {
        return NextResponse.json(
          { error: "ICE 후보 정보가 올바르지 않습니다." },
          { status: 400 },
        );
      }

      return NextResponse.json(
        await postRoomSignal({
          code,
          playerId,
          targetId,
          targetInstanceId,
          signal: {
            kind: "ice",
            candidate: {
              candidate: payload.candidate.candidate,
              sdpMid:
                typeof payload.candidate.sdpMid === "string"
                  ? payload.candidate.sdpMid
                  : null,
              sdpMLineIndex:
                typeof payload.candidate.sdpMLineIndex === "number"
                  ? payload.candidate.sdpMLineIndex
                  : null,
              usernameFragment:
                typeof payload.candidate.usernameFragment === "string"
                  ? payload.candidate.usernameFragment
                  : null,
            },
          },
        }),
      );
    }

    return NextResponse.json(
      { error: "지원하지 않는 signaling 타입입니다." },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "신호를 처리하지 못했습니다.",
      },
      { status: 400 },
    );
  }
}
