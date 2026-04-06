import { NextResponse } from "next/server";
import { postRoomSignals } from "@/lib/room-store";
import { type RoomClientSignal } from "@/lib/room-types";

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
  const connectionId =
    typeof payload?.connectionId === "string"
      ? payload.connectionId.trim()
      : "";
  const targetInstanceId =
    typeof payload?.targetInstanceId === "string"
      ? payload.targetInstanceId.trim()
      : null;
  const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "";
  const signals = Array.isArray(payload?.signals)
    ? payload.signals
    : connectionId && kind
      ? [{ connectionId, kind, description: payload?.description, candidate: payload?.candidate }]
      : [];

  if (!playerId || !targetId || signals.length === 0) {
    return NextResponse.json(
      { error: "신호를 보낼 플레이어 정보가 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    const normalizedSignals: RoomClientSignal[] = [];

    for (const signal of signals) {
      if (!signal || typeof signal !== "object") {
        return NextResponse.json(
          { error: "신호 목록 형식이 올바르지 않습니다." },
          { status: 400 },
        );
      }

      const signalConnectionId =
        typeof signal.connectionId === "string" ? signal.connectionId.trim() : "";
      const signalKind =
        typeof signal.kind === "string" ? signal.kind.trim() : "";

      if (!signalConnectionId) {
        return NextResponse.json(
          { error: "신호 연결 식별자가 올바르지 않습니다." },
          { status: 400 },
        );
      }

      if (signalKind === "offer" || signalKind === "answer") {
        if (
          typeof signal.description !== "object" ||
          signal.description === null ||
          typeof signal.description.type !== "string"
        ) {
          return NextResponse.json(
            { error: "세션 설명 정보가 올바르지 않습니다." },
            { status: 400 },
          );
        }

        normalizedSignals.push({
          connectionId: signalConnectionId,
          kind: signalKind,
          description: {
            type: signal.description.type,
            sdp:
              typeof signal.description.sdp === "string"
                ? signal.description.sdp
                : "",
          },
        });

        continue;
      }

      if (signalKind === "ice") {
        if (
          typeof signal.candidate !== "object" ||
          signal.candidate === null ||
          typeof signal.candidate.candidate !== "string"
        ) {
          return NextResponse.json(
            { error: "ICE 후보 정보가 올바르지 않습니다." },
            { status: 400 },
          );
        }

        normalizedSignals.push({
          connectionId: signalConnectionId,
          kind: "ice",
          candidate: {
            candidate: signal.candidate.candidate,
            sdpMid:
              typeof signal.candidate.sdpMid === "string"
                ? signal.candidate.sdpMid
                : null,
            sdpMLineIndex:
              typeof signal.candidate.sdpMLineIndex === "number"
                ? signal.candidate.sdpMLineIndex
                : null,
            usernameFragment:
              typeof signal.candidate.usernameFragment === "string"
                ? signal.candidate.usernameFragment
                : null,
          },
        });

        continue;
      }

      return NextResponse.json(
        { error: "지원하지 않는 signaling 타입입니다." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      await postRoomSignals({
        code,
        playerId,
        targetId,
        targetInstanceId,
        signals: normalizedSignals,
      }),
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
