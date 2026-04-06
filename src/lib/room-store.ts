import "server-only";

import { getCache } from "@vercel/functions";
import {
  type PeerMessage,
  type RoomClientSignal,
  type RoomPlayer,
  type RoomRelayMessage,
  type RoomSignal,
  type RoomSnapshot,
  type RoomSync,
} from "@/lib/room-types";

type RoomRecord = Omit<RoomSnapshot, "invitePath">;

type RoomPresenceRecord = {
  playerId: string;
  lastSeenAt: string;
  instanceId: string | null;
};

const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const ROOM_TTL_SECONDS = ROOM_TTL_MS / 1000;
const SIGNAL_TTL_MS = 1000 * 60 * 10;
const MAX_SIGNAL_COUNT = 80;
const MAX_RELAY_MESSAGE_COUNT = 80;
const ROOM_CODE_LENGTH = 6;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const globalRoomStore = globalThis as typeof globalThis & {
  __ryanChessRooms?: Map<string, RoomRecord>;
  __ryanChessRoomInboxes?: Map<string, RoomSignal[]>;
  __ryanChessRoomRelayInboxes?: Map<string, RoomRelayMessage[]>;
  __ryanChessRoomPresence?: Map<string, RoomPresenceRecord>;
};

const localRooms = globalRoomStore.__ryanChessRooms ?? new Map<string, RoomRecord>();
const localInboxes =
  globalRoomStore.__ryanChessRoomInboxes ?? new Map<string, RoomSignal[]>();
const localRelayInboxes =
  globalRoomStore.__ryanChessRoomRelayInboxes ??
  new Map<string, RoomRelayMessage[]>();
const localPresence =
  globalRoomStore.__ryanChessRoomPresence ?? new Map<string, RoomPresenceRecord>();

globalRoomStore.__ryanChessRooms = localRooms;
globalRoomStore.__ryanChessRoomInboxes = localInboxes;
globalRoomStore.__ryanChessRoomRelayInboxes = localRelayInboxes;
globalRoomStore.__ryanChessRoomPresence = localPresence;

function nowIso() {
  return new Date().toISOString();
}

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function roomKey(code: string) {
  return `ryan-chess:room:${normalizeCode(code)}`;
}

function roomPresenceKey(code: string, playerId: string) {
  return `ryan-chess:room:${normalizeCode(code)}:presence:${playerId}`;
}

function roomInboxKey(code: string, playerId: string) {
  return `ryan-chess:room:${normalizeCode(code)}:inbox:${playerId}`;
}

function roomRelayInboxKey(code: string, playerId: string) {
  return `ryan-chess:room:${normalizeCode(code)}:relay:${playerId}`;
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
    if (new Date(room.updatedAt).getTime() >= cutoff) {
      continue;
    }

    localRooms.delete(code);

    for (const player of room.players) {
      localInboxes.delete(roomInboxKey(code, player.id));
      localRelayInboxes.delete(roomRelayInboxKey(code, player.id));
      localPresence.delete(roomPresenceKey(code, player.id));
    }
  }
}

async function readRoomRecord(code: string) {
  const normalizedCode = normalizeCode(code);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    const room = (await cache.get(roomKey(normalizedCode))) as
      | RoomRecord
      | undefined;

    return room ?? null;
  }

  cleanupLocalRooms();
  return localRooms.get(normalizedCode) ?? null;
}

async function writeRoomRecord(room: RoomRecord) {
  const normalizedCode = normalizeCode(room.code);
  const nextRoom: RoomRecord = {
    ...room,
    code: normalizedCode,
    status: deriveStatus(room.players),
  };

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

async function readPlayerPresence(code: string, playerId: string) {
  const normalizedCode = normalizeCode(code);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    const presence = (await cache.get(
      roomPresenceKey(normalizedCode, playerId),
    )) as RoomPresenceRecord | undefined;

    return presence ?? null;
  }

  cleanupLocalRooms();
  return localPresence.get(roomPresenceKey(normalizedCode, playerId)) ?? null;
}

async function writePlayerPresence(
  code: string,
  playerId: string,
  presence: RoomPresenceRecord,
) {
  const normalizedCode = normalizeCode(code);
  const key = roomPresenceKey(normalizedCode, playerId);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();

    await cache.set(key, presence, {
      ttl: ROOM_TTL_SECONDS,
      tags: [roomTag(normalizedCode), "ryan-chess-room"],
    });

    return;
  }

  cleanupLocalRooms();
  localPresence.set(key, presence);
}

async function deletePlayerPresence(code: string, playerId: string) {
  const normalizedCode = normalizeCode(code);
  const key = roomPresenceKey(normalizedCode, playerId);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    await cache.delete(key);
    return;
  }

  localPresence.delete(key);
}

async function readPlayerInbox(code: string, playerId: string) {
  const normalizedCode = normalizeCode(code);
  const key = roomInboxKey(normalizedCode, playerId);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    const signals = (await cache.get(key)) as RoomSignal[] | undefined;

    return signals ?? [];
  }

  cleanupLocalRooms();
  return localInboxes.get(key) ?? [];
}

async function writePlayerInbox(
  code: string,
  playerId: string,
  signals: RoomSignal[],
) {
  const normalizedCode = normalizeCode(code);
  const key = roomInboxKey(normalizedCode, playerId);
  const cutoff = Date.now() - SIGNAL_TTL_MS;
  const nextSignals = signals
    .filter((signal) => new Date(signal.createdAt).getTime() >= cutoff)
    .slice(-MAX_SIGNAL_COUNT);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();

    await cache.set(key, nextSignals, {
      ttl: ROOM_TTL_SECONDS,
      tags: [roomTag(normalizedCode), "ryan-chess-room"],
    });

    return;
  }

  cleanupLocalRooms();
  localInboxes.set(key, nextSignals);
}

async function deletePlayerInbox(code: string, playerId: string) {
  const normalizedCode = normalizeCode(code);
  const key = roomInboxKey(normalizedCode, playerId);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    await cache.delete(key);
    return;
  }

  localInboxes.delete(key);
}

async function readPlayerRelayInbox(code: string, playerId: string) {
  const normalizedCode = normalizeCode(code);
  const key = roomRelayInboxKey(normalizedCode, playerId);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    const messages = (await cache.get(key)) as RoomRelayMessage[] | undefined;

    return messages ?? [];
  }

  cleanupLocalRooms();
  return localRelayInboxes.get(key) ?? [];
}

async function writePlayerRelayInbox(
  code: string,
  playerId: string,
  messages: RoomRelayMessage[],
) {
  const normalizedCode = normalizeCode(code);
  const key = roomRelayInboxKey(normalizedCode, playerId);
  const cutoff = Date.now() - SIGNAL_TTL_MS;
  const nextMessages = messages
    .filter((message) => new Date(message.createdAt).getTime() >= cutoff)
    .slice(-MAX_RELAY_MESSAGE_COUNT);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();

    await cache.set(key, nextMessages, {
      ttl: ROOM_TTL_SECONDS,
      tags: [roomTag(normalizedCode), "ryan-chess-room"],
    });

    return;
  }

  cleanupLocalRooms();
  localRelayInboxes.set(key, nextMessages);
}

async function deletePlayerRelayInbox(code: string, playerId: string) {
  const normalizedCode = normalizeCode(code);
  const key = roomRelayInboxKey(normalizedCode, playerId);

  if (shouldUseRuntimeCache()) {
    const cache = getCache();
    await cache.delete(key);
    return;
  }

  localRelayInboxes.delete(key);
}

async function getRoomRecordOrThrow(code: string) {
  const room = await readRoomRecord(code);

  if (!room) {
    throw new Error("방을 찾을 수 없습니다.");
  }

  return room;
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

async function buildRoomSnapshot(room: RoomRecord): Promise<RoomSnapshot> {
  const players = await Promise.all(
    room.players.map(async (player) => {
      const presence = await readPlayerPresence(room.code, player.id);

      if (!presence) {
        return player;
      }

      return {
        ...player,
        lastSeenAt: presence.lastSeenAt,
        instanceId: presence.instanceId ?? player.instanceId,
      };
    }),
  );

  return {
    ...room,
    players,
    invitePath: `/?room=${room.code}`,
  };
}

async function initializePlayerSession(
  code: string,
  player: RoomPlayer,
  instanceId: string,
) {
  await Promise.all([
    writePlayerPresence(code, player.id, {
      playerId: player.id,
      lastSeenAt: nowIso(),
      instanceId,
    }),
    writePlayerInbox(code, player.id, []),
    writePlayerRelayInbox(code, player.id, []),
  ]);
}

function filterSignalsForPlayer<T extends { targetInstanceId: string | null }>(
  signals: T[],
  instanceId?: string,
): T[] {
  if (!instanceId) {
    return signals;
  }

  return signals.filter((signal) => {
    return !signal.targetInstanceId || signal.targetInstanceId === instanceId;
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
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  await initializePlayerSession(code, host, instanceId);

  return {
    room: await buildRoomSnapshot(room),
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
  const nextRoom = await writeRoomRecord({
    ...room,
    players: [...room.players, guest],
    updatedAt: nowIso(),
  });

  await Promise.all(
    nextRoom.players.map((player) => {
      return initializePlayerSession(
        code,
        player,
        player.id === guest.id ? instanceId : player.instanceId ?? "",
      );
    }),
  );

  return {
    room: await buildRoomSnapshot(nextRoom),
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
    const player = room.players.find((entry) => entry.id === input.playerId);

    if (!player) {
      throw new Error("방 참가자 정보를 찾을 수 없습니다.");
    }
  }

  const roomSnapshot = await buildRoomSnapshot(room);
  const signals = input.playerId
    ? filterSignalsForPlayer(
        await readPlayerInbox(input.code, input.playerId),
        input.instanceId,
      )
    : [];
  const messages = input.playerId
    ? filterSignalsForPlayer(
        await readPlayerRelayInbox(input.code, input.playerId),
        input.instanceId,
      )
    : [];

  return {
    room: roomSnapshot,
    signals,
    messages,
  };
}

export async function heartbeatRoomPlayer(input: {
  code: string;
  playerId: string;
  instanceId: string;
}) {
  const room = await getRoomRecordOrThrow(input.code);
  const player = room.players.find((entry) => entry.id === input.playerId);

  if (!player) {
    throw new Error("방 참가자 정보를 찾을 수 없습니다.");
  }

  await writePlayerPresence(input.code, input.playerId, {
    playerId: input.playerId,
    lastSeenAt: nowIso(),
    instanceId: input.instanceId,
  });

  return {
    ok: true,
  };
}

export async function postRoomSignals(input: {
  code: string;
  playerId: string;
  targetId: string;
  targetInstanceId?: string | null;
  signals: RoomClientSignal[];
}) {
  if (input.signals.length === 0) {
    return {
      ok: true,
    };
  }

  const room = await getRoomRecordOrThrow(input.code);
  const sender = room.players.find((entry) => entry.id === input.playerId);
  const target = room.players.find((entry) => entry.id === input.targetId);

  if (!sender) {
    throw new Error("방 참가자 정보를 찾을 수 없습니다.");
  }

  if (!target) {
    throw new Error("상대 참가자를 찾을 수 없습니다.");
  }

  if (sender.id === target.id) {
    throw new Error("자기 자신에게 신호를 보낼 수 없습니다.");
  }

  const senderPresence = await readPlayerPresence(input.code, sender.id);
  const targetPresence = await readPlayerPresence(input.code, target.id);
  const timestamp = nowIso();
  const pendingSignals = await readPlayerInbox(input.code, target.id);
  const nextSignals = pendingSignals.concat(
    input.signals.map((signal) => {
      const baseSignal = {
        id: crypto.randomUUID(),
        connectionId: signal.connectionId,
        senderId: sender.id,
        senderInstanceId: senderPresence?.instanceId ?? sender.instanceId,
        targetId: target.id,
        targetInstanceId:
          input.targetInstanceId ??
          targetPresence?.instanceId ??
          target.instanceId ??
          null,
        createdAt: timestamp,
      };

      return signal.kind === "ice"
        ? {
            ...baseSignal,
            kind: "ice" as const,
            candidate: signal.candidate,
          }
        : {
            ...baseSignal,
            kind: signal.kind,
            description: signal.description,
          };
    }),
  );

  await Promise.all([
    writePlayerInbox(input.code, target.id, nextSignals),
    writePlayerPresence(input.code, sender.id, {
      playerId: sender.id,
      lastSeenAt: timestamp,
      instanceId: senderPresence?.instanceId ?? sender.instanceId,
    }),
  ]);

  return {
    ok: true,
  };
}

export async function postRoomRelayMessage(input: {
  code: string;
  playerId: string;
  targetId: string;
  targetInstanceId?: string | null;
  message: PeerMessage;
}) {
  const room = await getRoomRecordOrThrow(input.code);
  const sender = room.players.find((entry) => entry.id === input.playerId);
  const target = room.players.find((entry) => entry.id === input.targetId);

  if (!sender) {
    throw new Error("방 참가자 정보를 찾을 수 없습니다.");
  }

  if (!target) {
    throw new Error("상대 참가자를 찾을 수 없습니다.");
  }

  if (sender.id === target.id) {
    throw new Error("자기 자신에게 메시지를 보낼 수 없습니다.");
  }

  const senderPresence = await readPlayerPresence(input.code, sender.id);
  const targetPresence = await readPlayerPresence(input.code, target.id);
  const timestamp = nowIso();
  const pendingMessages = await readPlayerRelayInbox(input.code, target.id);

  await Promise.all([
    writePlayerRelayInbox(input.code, target.id, [
      ...pendingMessages,
      {
        id: crypto.randomUUID(),
        senderId: sender.id,
        senderInstanceId: senderPresence?.instanceId ?? sender.instanceId,
        targetId: target.id,
        targetInstanceId:
          input.targetInstanceId ??
          targetPresence?.instanceId ??
          target.instanceId ??
          null,
        createdAt: timestamp,
        message: input.message,
      },
    ]),
    writePlayerPresence(input.code, sender.id, {
      playerId: sender.id,
      lastSeenAt: timestamp,
      instanceId: senderPresence?.instanceId ?? sender.instanceId,
    }),
  ]);

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
    await Promise.all([
      deleteRoomRecord(code),
      ...room.players.flatMap((entry) => {
        return [
          deletePlayerInbox(code, entry.id),
          deletePlayerRelayInbox(code, entry.id),
          deletePlayerPresence(code, entry.id),
        ];
      }),
    ]);

    return {
      closed: true,
      room: null,
    };
  }

  const nextPlayers = room.players.filter((entry) => entry.id !== playerId);
  const nextRoom = await writeRoomRecord({
    ...room,
    players: nextPlayers,
    updatedAt: nowIso(),
  });

  await Promise.all([
    deletePlayerInbox(code, playerId),
    deletePlayerRelayInbox(code, playerId),
    deletePlayerPresence(code, playerId),
    ...nextPlayers.map((entry) => deletePlayerInbox(code, entry.id)),
    ...nextPlayers.map((entry) => deletePlayerRelayInbox(code, entry.id)),
    ...nextPlayers.map((entry) => initializePlayerSession(code, entry, entry.instanceId ?? "")),
  ]);

  return {
    closed: false,
    room: await buildRoomSnapshot(nextRoom),
  };
}
