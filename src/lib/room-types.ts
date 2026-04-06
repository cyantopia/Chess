import { Chess, type Color, type Move, type Square } from "chess.js";

export type RoomColor = "white" | "black";
export type RoomStatus = "waiting" | "paired";
export type MatchStatus = "waiting" | "active" | "finished";

export type RoomPlayer = {
  id: string;
  name: string;
  color: RoomColor;
  joinedAt: string;
  lastSeenAt: string;
  instanceId: string | null;
};

export type RoomMove = {
  san: string;
  lan: string;
  from: Square;
  to: Square;
  color: RoomColor;
  at: string;
};

export type RoomResult =
  | {
      kind:
        | "checkmate"
        | "stalemate"
        | "threefold-repetition"
        | "insufficient-material"
        | "fifty-move";
      winner: RoomColor | null;
      message: string;
    }
  | null;

export type MatchState = {
  fen: string;
  turn: RoomColor;
  moveHistory: RoomMove[];
  lastMove: {
    from: Square;
    to: Square;
  } | null;
  result: RoomResult;
  status: MatchStatus;
  updatedAt: string;
};

export type RoomSnapshot = {
  code: string;
  status: RoomStatus;
  players: RoomPlayer[];
  createdAt: string;
  updatedAt: string;
  invitePath: string;
};

export type RoomSignal =
  | {
      id: string;
      connectionId: string;
      kind: "offer" | "answer";
      senderId: string;
      senderInstanceId: string | null;
      targetId: string;
      targetInstanceId: string | null;
      createdAt: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      id: string;
      connectionId: string;
      kind: "ice";
      senderId: string;
      senderInstanceId: string | null;
      targetId: string;
      targetInstanceId: string | null;
      createdAt: string;
      candidate: RTCIceCandidateInit;
    };

export type RoomClientSignal =
  | {
      connectionId: string;
      kind: "offer" | "answer";
      description: RTCSessionDescriptionInit;
    }
  | {
      connectionId: string;
      kind: "ice";
      candidate: RTCIceCandidateInit;
    };

export type PeerMoveRequest = {
  from: Square;
  to: Square;
  promotion: "q" | "r" | "b" | "n";
};

export type RoomSync = {
  room: RoomSnapshot;
  signals: RoomSignal[];
  messages: RoomRelayMessage[];
};

export type RoomSession = {
  roomCode: string;
  playerId: string;
  playerName: string;
};

export type PeerMessage =
  | {
      kind: "match-sync";
      match: MatchState;
      sentAt: string;
    }
  | {
      kind: "move-request";
      move: PeerMoveRequest;
      sentAt: string;
    };

export type RoomRelayMessage = {
  id: string;
  senderId: string;
  senderInstanceId: string | null;
  targetId: string;
  targetInstanceId: string | null;
  createdAt: string;
  message: PeerMessage;
};

export function createInitialMatchState(
  status: MatchStatus = "waiting",
): MatchState {
  const game = new Chess();

  return {
    fen: game.fen(),
    turn: "white",
    moveHistory: [],
    lastMove: null,
    result: null,
    status,
    updatedAt: new Date().toISOString(),
  };
}

export function toRoomColor(color: Color): RoomColor {
  return color === "w" ? "white" : "black";
}

export function toChessColor(color: RoomColor): Color {
  return color === "white" ? "w" : "b";
}

export function sideLabel(color: RoomColor | Color): string {
  return color === "white" || color === "w" ? "백" : "흑";
}

export function serializeMove(move: Move, at = new Date().toISOString()): RoomMove {
  return {
    san: move.san,
    lan: move.lan,
    from: move.from,
    to: move.to,
    color: toRoomColor(move.color),
    at,
  };
}

export function getRoomResult(game: Chess): RoomResult {
  if (game.isCheckmate()) {
    const winner = game.turn() === "w" ? "black" : "white";

    return {
      kind: "checkmate",
      winner,
      message: `${sideLabel(winner)} 승리, 체크메이트`,
    };
  }

  if (game.isStalemate()) {
    return {
      kind: "stalemate",
      winner: null,
      message: "스테일메이트로 무승부",
    };
  }

  if (game.isThreefoldRepetition()) {
    return {
      kind: "threefold-repetition",
      winner: null,
      message: "삼회 반복으로 무승부",
    };
  }

  if (game.isInsufficientMaterial()) {
    return {
      kind: "insufficient-material",
      winner: null,
      message: "기물 부족으로 무승부",
    };
  }

  if (game.isDrawByFiftyMoves()) {
    return {
      kind: "fifty-move",
      winner: null,
      message: "50수 규칙으로 무승부",
    };
  }

  return null;
}
