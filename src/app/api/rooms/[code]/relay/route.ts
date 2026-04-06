import { NextResponse } from "next/server";
import { postRoomRelayMessage } from "@/lib/room-store";
import { type PeerMessage, type PeerMoveRequest } from "@/lib/room-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "home";

function normalizeMoveRequest(move: unknown) {
  if (!move || typeof move !== "object") {
    return null;
  }

  const input = move as Partial<PeerMoveRequest>;

  if (
    typeof input.from !== "string" ||
    typeof input.to !== "string" ||
    typeof input.promotion !== "string"
  ) {
    return null;
  }

  if (!["q", "r", "b", "n"].includes(input.promotion)) {
    return null;
  }

  return {
    from: input.from,
    to: input.to,
    promotion: input.promotion,
  } satisfies PeerMoveRequest;
}

function normalizeMessage(message: unknown): PeerMessage | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const input = message as Partial<PeerMessage>;

  if (input.kind === "match-sync") {
    if (!input.match || typeof input.match !== "object") {
      return null;
    }

    return {
      kind: "match-sync",
      match: input.match,
      sentAt:
        typeof input.sentAt === "string"
          ? input.sentAt
          : new Date().toISOString(),
    };
  }

  if (input.kind === "move-request") {
    const move = normalizeMoveRequest(input.move);

    if (!move) {
      return null;
    }

    return {
      kind: "move-request",
      move,
      sentAt:
        typeof input.sentAt === "string"
          ? input.sentAt
          : new Date().toISOString(),
    };
  }

  return null;
}

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
  const message = normalizeMessage(payload?.message);

  if (!playerId || !targetId || !message) {
    return NextResponse.json(
      { error: "릴레이 메시지 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await postRoomRelayMessage({
        code,
        playerId,
        targetId,
        targetInstanceId,
        message,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "릴레이 메시지를 처리하지 못했습니다.",
      },
      { status: 400 },
    );
  }
}
