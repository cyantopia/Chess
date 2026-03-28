import "server-only";

import { getCache } from "@vercel/functions";
import {
  type RoomPlayer,
  type RoomSignal,
  type RoomSnapshot,
  type RoomSync,
} from "@/lib/room-types";

type RoomRecord = Omit<RoomSnapshot, "invitePath"> & {
  signals: RoomSignal[];
};

const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const ROOM_TTL_SECONDS = ROOM_TTL_MS / 1000;
const SIGNAL_TTL_MS = 1000 * 60 * 10;
const MAX_SIGNAL_COUNT = 80;
const ROOM_CODE_LENGTH = 6;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const globalRoomStore = globalThis as typeof globalThis & {
  __ryanChessRooms?: Map<string, RoomRecord>;
};

const localRooms = globalRoomStore.__ryanChessRooms ?? new Map<string, RoomRecord>();
globalRoomStore.__ryanChessRooms = localRooms;

function nowIso() {
  return new Date().toISOString();
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function roomKey(code: string) {
  return `ryan-chess:room:${normalizeCode(code)}`;
}

function roomTag(code: string) {
  return `ryan-chess-room:${normalizeCode(code)}`;
}

function shouldUseRuntimeCache() {
  return process.env.VERCEL === "1";
}

function deriveStatus(players: RoomPlayer[]): RoomSnapshot["status"] {
  return players.length >= 2 ? "paired" : "waiting";
}

function cleanupLocalRooms() {
  const cutoff = Date.now() - ROOM_TTL_MS;

  for (const [code, room] of localRooms.entries()) {
    if (new Date(room.updatedAt).getTime() < cutoff) {
      localRooms.delete(code);
    }
  }
}

function pruneSignals(room: RoomRecord) {
  const activePlayerIds = new Set(room.players.map((player) => player.id));
  const cutoff = Date.now() - SIGNAL_TTL_MS;

  const signals = room.signals
    .filter((signal) => {
      return (
        activePlayerIds.has(signal.senderId) &&
        activePlayerIds.has(signal.targetId) &&
        new Date(signal.createdAt).getTime() >= cutoff
      );
    })
    .slice(-MAX_SIGNAL_COUNT);

  if (signals.length === room.signals.length) {
    return room;
  }

  return {
    ...room,
    signals,
  };
}

function serializeRoom(room: RoomRecord): RoomSnapshot {
  return {
    code: room.code,
    status: room.status,
    players: room.players,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    invitePath: `/?room=${room.code}`,
  };
}

function createPlayer(
  name: string,
  color: RoomPlayer["color"],
  instanceId: string,
): RoomPlayer {
  const timestamp = nowIso();

  return {
    id: crypto.randomUUID(),
    name,
    color,
    joinedAt: timestamp,
    lastSeenAt: timestamp,
    instanceId,
  };
}

async function readRoomRecord(code: string) {
  const normalizedCode = normalizeCode(code);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    const room = (await cache.get(roomKey(normalizedCode))) as
      | RoomRecord
      | undefined;

    if (!room) {
      return null;
    }

    const prunedRoom = pruneSignals(room);

    if (prunedRoom !== room) {
      await cache.set(roomKey(normalizedCode), prunedRoom, {
        ttl: ROOM_TTL_SECONDS,
        tags: [roomTag(normalizedCode), "ryan-chess-room"],
      });
    }

    return prunedRoom;
  }

  cleanupLocalRooms();
  const room = localRooms.get(normalizedCode);

  if (!room) {
    return null;
  }

  const prunedRoom = pruneSignals(room);

  if (prunedRoom !== room) {
    localRooms.set(normalizedCode, prunedRoom);
  }

  return prunedRoom;
}

async function writeRoomRecord(room: RoomRecord) {
  const normalizedCode = normalizeCode(room.code);
  const nextRoom = pruneSignals({
    ...room,
    code: normalizedCode,
    status: deriveStatus(room.players),
  });

  if (shouldUseRuntimeCache()) {
    const cache = getCache();

    await cache.set(roomKey(normalizedCode), nextRoom, {
      ttl: ROOM_TTL_SECONDS,
      tags: [roomTag(normalizedCode), "ryan-chess-room"],
    });

    return nextRoom;
  }

  cleanupLocalRooms();
  localRooms.set(normalizedCode, nextRoom);
  return nextRoom;
}

async function deleteRoomRecord(code: string) {
  const normalizedCode = normalizeCode(code);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    await cache.delete(roomKey(normalizedCode));
    return;
  }

  localRooms.delete(normalizedCode);
}

async function getRoomRecordOrThrow(code: string) {
  const room = await readRoomRecord(code);

  if (!room) {
    throw new Error("방을 찾을 수 없습니다.");
  }

  return room;
}

function touchPlayer(room: RoomRecord, playerId: string, instanceId?: string) {
  const player = room.players.find((entry) => entry.id === playerId);

  if (!player) {
    throw new Error("방 참가자 정보를 찾을 수 없습니다.");
  }

  const timestamp = nowIso();
  player.lastSeenAt = timestamp;

  if (instanceId) {
    player.instanceId = instanceId;
  }

  room.updatedAt = timestamp;

  return player;
}

async function createCode() {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const code = Array.from({ length: ROOM_CODE_LENGTH }, () => {
      const index = Math.floor(Math.random() * ROOM_ALPHABET.length);
      return ROOM_ALPHABET[index];
    }).join("");

    const room = await readRoomRecord(code);

    if (!room) {
      return code;
    }
  }

  throw new Error("방 코드를 생성하지 못했습니다.");
}

function filterSignalsForPlayer(
  room: RoomRecord,
  playerId?: string,
  instanceId?: string,
) {
  if (!playerId) {
    return [];
  }

  return room.signals.filter((signal) => {
    return (
      signal.targetId === playerId &&
      (!signal.targetInstanceId || signal.targetInstanceId === instanceId)
    );
  });
}

export async function createRoom(playerName: string, instanceId: string) {
  const code = await createCode();
  const timestamp = nowIso();
  const host = createPlayer(playerName, "white", instanceId);

  const room = await writeRoomRecord({
    code,
    status: "waiting",
    players: [host],
    signals: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    room: serializeRoom(room),
    playerId: host.id,
  };
}

export async function joinRoom(
  code: string,
  playerName: string,
  instanceId: string,
) {
  const room = await getRoomRecordOrThrow(code);

  if (room.players.length >= 2) {
    throw new Error("이미 가득 찬 방입니다.");
  }

  const guest = createPlayer(playerName, "black", instanceId);
  room.players.push(guest);
  room.status = "paired";
  room.signals = [];
  room.updatedAt = nowIso();

  const nextRoom = await writeRoomRecord(room);

  return {
    room: serializeRoom(nextRoom),
    playerId: guest.id,
  };
}

export async function getRoomSync(input: {
  code: string;
  playerId?: string;
  instanceId?: string;
}): Promise<RoomSync> {
  const room = await getRoomRecordOrThrow(input.code);

  if (input.playerId) {
    touchPlayer(room, input.playerId, input.instanceId);
    await writeRoomRecord(room);
  }

  return {
    room: serializeRoom(room),
    signals: filterSignalsForPlayer(room, input.playerId, input.instanceId),
  };
}

export async function postRoomSignal(input: {
  code: string;
  playerId: string;
  targetId: string;
  targetInstanceId?: string | null;
  signal:
    | {
        kind: "offer" | "answer";
        description: RTCSessionDescriptionInit;
      }
    | {
        kind: "ice";
        candidate: RTCIceCandidateInit;
      };
}) {
  const room = await getRoomRecordOrThrow(input.code);
  const sender = touchPlayer(room, input.playerId);
  const target = room.players.find((entry) => entry.id === input.targetId);

  if (!target) {
    throw new Error("상대 참가자를 찾을 수 없습니다.");
  }

  if (sender.id === target.id) {
    throw new Error("자기 자신에게 신호를 보낼 수 없습니다.");
  }

  const baseSignal = {
    id: crypto.randomUUID(),
    senderId: sender.id,
    senderInstanceId: sender.instanceId,
    targetId: target.id,
    targetInstanceId: input.targetInstanceId ?? target.instanceId ?? null,
    createdAt: nowIso(),
  };

  room.signals.push(
    input.signal.kind === "ice"
      ? {
          ...baseSignal,
          kind: "ice",
          candidate: input.signal.candidate,
        }
      : {
          ...baseSignal,
          kind: input.signal.kind,
          description: input.signal.description,
        },
  );

  room.updatedAt = nowIso();

  await writeRoomRecord(room);

  return {
    ok: true,
  };
}

export async function leaveRoom(code: string, playerId: string) {
  const room = await getRoomRecordOrThrow(code);
  const player = room.players.find((entry) => entry.id === playerId);

  if (!player) {
    throw new Error("방 참가자 정보를 찾을 수 없습니다.");
  }

  if (player.color === "white") {
    await deleteRoomRecord(code);

    return {
      closed: true,
      room: null,
    };
  }

  room.players = room.players.filter((entry) => entry.id !== playerId);
  room.signals = room.signals.filter((signal) => {
    return signal.senderId !== playerId && signal.targetId !== playerId;
  });
  room.status = "waiting";
  room.updatedAt = nowIso();

  const nextRoom = await writeRoomRecord(room);

  return {
    closed: false,
    room: serializeRoom(nextRoom),
  };
}
