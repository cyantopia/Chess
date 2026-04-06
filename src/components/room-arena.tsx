"use client";

import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  createInitialMatchState,
  getRoomResult,
  serializeMove,
  sideLabel,
  type PeerMoveRequest,
  toChessColor,
  toRoomColor,
  type MatchState,
  type PeerMessage,
  type RoomClientSignal,
  type RoomRelayMessage,
  type RoomPlayer,
  type RoomSession,
  type RoomSignal,
  type RoomSnapshot,
  type RoomSync,
} from "@/lib/room-types";

const ROOM_SESSION_KEY = "ryan-chess-room-session";
const ROOM_MATCH_STATE_PREFIX = "ryan-chess-room-match";
const ROOM_PLAYER_NAME_KEY = "ryan-chess-player-name";
const ROOM_INSTANCE_ID_KEY = "ryan-chess-room-instance-id";
const ROOM_POLL_INTERVAL_MS = 1200;
const HEARTBEAT_INTERVAL_MS = 10_000;
const DISCONNECT_RECOVERY_MS = 3200;
const SIGNAL_FLUSH_DELAY_MS = 140;
const MAX_OUTGOING_SIGNAL_BUFFER = 80;
const MAX_EVENT_LOGS = 72;

type BusyMode = "create" | "join" | null;
type ConnectionStatus =
  | "idle"
  | "waiting-peer"
  | "negotiating"
  | "connected"
  | "disconnected";
type TransportMode = "none" | "relay" | "webrtc";

type PendingCandidate = {
  connectionId: string;
  candidate: RTCIceCandidateInit;
};

type RoomEventEntry = {
  id: string;
  at: string;
  label: string;
  detail: string;
  level: "info" | "warn" | "error";
};

function parseIceServerUrls(
  value: string | undefined,
  fallback: string[] = [],
) {
  const urls = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return urls.length > 0 ? urls : fallback;
}

function createRtcConfiguration(): RTCConfiguration {
  const stunUrls = parseIceServerUrls(process.env.NEXT_PUBLIC_WEBRTC_STUN_URLS, [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
  ]);
  const turnUrls = parseIceServerUrls(process.env.NEXT_PUBLIC_WEBRTC_TURN_URLS);
  const turnUsername = process.env.NEXT_PUBLIC_WEBRTC_TURN_USERNAME?.trim();
  const turnCredential = process.env.NEXT_PUBLIC_WEBRTC_TURN_CREDENTIAL?.trim();
  const iceServers: RTCIceServer[] = [];

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return {
    iceServers,
  };
}

const RTC_CONFIGURATION = createRtcConfiguration();
const ICE_SERVER_COUNT = RTC_CONFIGURATION.iceServers?.length ?? 0;
const TURN_CONFIGURED = (RTC_CONFIGURATION.iceServers ?? []).some((server) => {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
});

function getMatchStorageKey(session: RoomSession) {
  return `${ROOM_MATCH_STATE_PREFIX}:${session.roomCode}:${session.playerId}`;
}

async function requestRoomSync(session: RoomSession, instanceId: string) {
  const searchParams = new URLSearchParams({
    playerId: session.playerId,
    instanceId,
  });
  const response = await fetch(`/api/rooms/${session.roomCode}?${searchParams}`, {
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | (Partial<RoomSync> & {
        error?: string;
      })
    | null;

  return {
    ok: response.ok,
    status: response.status,
    room: payload?.room ?? null,
    signals: Array.isArray(payload?.signals) ? payload.signals : [],
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    error: payload?.error ?? "방 상태를 불러오지 못했습니다.",
  };
}

function buildLastMoveStyles(lastMove: MatchState["lastMove"]) {
  if (!lastMove) {
    return {};
  }

  const highlight: CSSProperties = {
    background:
      "linear-gradient(135deg, rgba(255, 199, 95, 0.68), rgba(255, 231, 177, 0.3))",
  };

  return {
    [lastMove.from]: highlight,
    [lastMove.to]: highlight,
  } satisfies Record<string, CSSProperties>;
}

function getPresenceState(player?: RoomPlayer) {
  if (!player) {
    return "빈 자리";
  }

  return isPlayerOnline(player) ? "온라인" : "잠시 비움";
}

function isPlayerOnline(player?: RoomPlayer) {
  if (!player) {
    return false;
  }

  return Date.now() - new Date(player.lastSeenAt).getTime() < 15_000;
}

function getPlayerMonogram(player?: RoomPlayer) {
  const name = player?.name?.trim();

  if (!name) {
    return "--";
  }

  return name.slice(0, 2).toUpperCase();
}

function trimName(value: string) {
  return value.trim().slice(0, 18);
}

function withDerivedMatchStatus(match: MatchState, room: RoomSnapshot | null) {
  const nextStatus: MatchState["status"] =
    room && room.players.length === 2
      ? match.result
        ? "finished"
        : "active"
      : match.result
        ? "finished"
        : "waiting";

  if (match.status === nextStatus) {
    return match;
  }

  return {
    ...match,
    status: nextStatus,
  };
}

function chooseRemotePlayer(room: RoomSnapshot | null, playerId?: string) {
  if (!room || !playerId) {
    return null;
  }

  return room.players.find((entry) => entry.id !== playerId) ?? null;
}

function serializeDescription(
  description: RTCSessionDescriptionInit | RTCSessionDescription | null,
) {
  if (!description || !description.type) {
    return null;
  }

  return {
    type: description.type,
    sdp: description.sdp ?? "",
  } satisfies RTCSessionDescriptionInit;
}

function shouldAdoptRemoteMatch(localMatch: MatchState, remoteMatch: MatchState) {
  if (remoteMatch.moveHistory.length !== localMatch.moveHistory.length) {
    return remoteMatch.moveHistory.length > localMatch.moveHistory.length;
  }

  if (remoteMatch.result && !localMatch.result) {
    return true;
  }

  return (
    new Date(remoteMatch.updatedAt).getTime() >
    new Date(localMatch.updatedAt).getTime()
  );
}

export function RoomArena() {
  const [playerName, setPlayerName] = useState("Ryan");
  const [joinCode, setJoinCode] = useState("");
  const [session, setSession] = useState<RoomSession | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [match, setMatch] = useState<MatchState>(() => createInitialMatchState());
  const [busyMode, setBusyMode] = useState<BusyMode>(null);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [isHydrated, setIsHydrated] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [, setEventLog] = useState<RoomEventEntry[]>([]);
  const [retryNonce, setRetryNonce] = useState(0);

  const syncingRef = useRef(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const disconnectRetryTimerRef = useRef<number | null>(null);
  const signalFlushTimerRef = useRef<number | null>(null);
  const signalFlushInFlightRef = useRef(false);
  const instanceIdRef = useRef("");
  const sessionRef = useRef<RoomSession | null>(null);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const matchRef = useRef(match);
  const connectionStatusRef = useRef<ConnectionStatus>("idle");
  const offeredForInstanceRef = useRef("");
  const activeConnectionIdRef = useRef("");
  const remoteInstanceRef = useRef("");
  const fallbackSyncRef = useRef("");
  const processedSignalIdsRef = useRef<Set<string>>(new Set());
  const processedRelayMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingIceCandidatesRef = useRef<PendingCandidate[]>([]);
  const outgoingSignalsRef = useRef<RoomClientSignal[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const currentPlayer =
    room?.players.find((entry) => entry.id === session?.playerId) ?? null;
  const remotePlayer = chooseRemotePlayer(room, session?.playerId);
  const whitePlayer = room?.players.find((entry) => entry.color === "white");
  const blackPlayer = room?.players.find((entry) => entry.color === "black");
  const transportMode: TransportMode =
    connectionStatus === "connected"
      ? "webrtc"
      : room && room.players.length === 2 && isPlayerOnline(remotePlayer ?? undefined)
        ? "relay"
        : "none";
  const isCurrentPlayerTurn =
    !!currentPlayer &&
    !!room &&
    transportMode !== "none" &&
    match.status === "active" &&
    !match.result &&
    match.turn === currentPlayer.color;
  const boardOrientation = currentPlayer?.color ?? "white";
  const allowDragging =
    !!room &&
    !!currentPlayer &&
    transportMode !== "none" &&
    match.status === "active" &&
    !match.result &&
    match.turn === currentPlayer.color;

  const ensureInstanceId = () => {
    if (!instanceIdRef.current) {
      const storedInstanceId = window.localStorage.getItem(ROOM_INSTANCE_ID_KEY);
      const nextInstanceId = storedInstanceId?.trim() || crypto.randomUUID();
      instanceIdRef.current = nextInstanceId;
      window.localStorage.setItem(ROOM_INSTANCE_ID_KEY, nextInstanceId);
    }

    return instanceIdRef.current;
  };

  const appendEvent = (
    label: string,
    detail = "",
    level: RoomEventEntry["level"] = "info",
  ) => {
    const entry: RoomEventEntry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      label,
      detail,
      level,
    };

    startTransition(() => {
      setEventLog((current) => [entry, ...current].slice(0, MAX_EVENT_LOGS));
    });
  };

  const setLiveConnectionStatus = (nextStatus: ConnectionStatus) => {
    connectionStatusRef.current = nextStatus;

    startTransition(() => {
      setConnectionStatus(nextStatus);
    });
  };

  const clearDisconnectRetryTimer = () => {
    if (!disconnectRetryTimerRef.current) {
      return;
    }

    window.clearTimeout(disconnectRetryTimerRef.current);
    disconnectRetryTimerRef.current = null;
  };

  const commitMatchState = (nextMatch: MatchState) => {
    const normalizedMatch = withDerivedMatchStatus(nextMatch, roomRef.current);
    matchRef.current = normalizedMatch;

    startTransition(() => {
      setMatch(normalizedMatch);
    });
  };

  const commitRoomSnapshot = (nextRoom: RoomSnapshot | null) => {
    roomRef.current = nextRoom;

    if (!nextRoom) {
      const initialMatch = createInitialMatchState();
      matchRef.current = initialMatch;

      startTransition(() => {
        setRoom(null);
        setMatch(initialMatch);
      });

      return;
    }

    const normalizedMatch = withDerivedMatchStatus(matchRef.current, nextRoom);
    matchRef.current = normalizedMatch;

    startTransition(() => {
      setRoom(nextRoom);
      setMatch(normalizedMatch);
    });
  };

  const sendPeerMessage = (message: PeerMessage) => {
    const channel = dataChannelRef.current;

    if (!channel || channel.readyState !== "open") {
      return false;
    }

    try {
      channel.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const postSignals = async (
    signals: RoomClientSignal[],
    source: "direct" | "queued" = "direct",
  ) => {
    const activeSession = sessionRef.current;
    const remotePlayer = chooseRemotePlayer(
      roomRef.current,
      activeSession?.playerId,
    );

    if (!activeSession || !remotePlayer || signals.length === 0) {
      return false;
    }

    try {
      const response = await fetch(`/api/rooms/${activeSession.roomCode}/signal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          playerId: activeSession.playerId,
          targetId: remotePlayer.id,
          targetInstanceId: remotePlayer.instanceId ?? null,
          signals,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | {
              error?: string;
            }
          | null;

        startTransition(() => {
          setErrorMessage(payload?.error ?? "연결 신호를 전달하지 못했습니다.");
        });
        appendEvent(
          "Signal send failed",
          `${source} / ${signals.map((signal) => signal.kind).join(", ")}`,
          "error",
        );

        return false;
      }

      appendEvent(
        "Signal sent",
        `${source} / ${signals.length}개 / ${signals
          .map((signal) => signal.kind)
          .join(", ")}`,
      );

      return true;
    } catch {
      startTransition(() => {
        setErrorMessage("연결 신호를 전달하지 못했습니다.");
      });
      appendEvent(
        "Signal network error",
        `${source} / ${signals.map((signal) => signal.kind).join(", ")}`,
        "error",
      );

      return false;
    }
  };

  const postRelayMessage = async (
    message: PeerMessage,
    source: "host-sync" | "guest-move" | "fallback-sync",
  ) => {
    const activeSession = sessionRef.current;
    const remotePlayer = chooseRemotePlayer(
      roomRef.current,
      activeSession?.playerId,
    );

    if (!activeSession || !remotePlayer) {
      return false;
    }

    try {
      const response = await fetch(`/api/rooms/${activeSession.roomCode}/relay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          playerId: activeSession.playerId,
          targetId: remotePlayer.id,
          targetInstanceId: remotePlayer.instanceId ?? null,
          message,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | {
              error?: string;
            }
          | null;

        startTransition(() => {
          setErrorMessage(payload?.error ?? "Vercel relay 전송에 실패했습니다.");
        });
        appendEvent("Relay send failed", source, "error");
        return false;
      }

      appendEvent("Relay sent", `${source} / ${message.kind}`);
      return true;
    } catch {
      startTransition(() => {
        setErrorMessage("Vercel relay 전송에 실패했습니다.");
      });
      appendEvent("Relay network error", source, "error");
      return false;
    }
  };

  const flushQueuedSignals = async () => {
    if (signalFlushInFlightRef.current || outgoingSignalsRef.current.length === 0) {
      return;
    }

    signalFlushInFlightRef.current = true;
    clearDisconnectRetryTimer();
    const batch = [...outgoingSignalsRef.current];
    outgoingSignalsRef.current = [];

    const sent = await postSignals(batch, "queued");

    if (!sent) {
      outgoingSignalsRef.current = [...batch, ...outgoingSignalsRef.current].slice(
        -MAX_OUTGOING_SIGNAL_BUFFER,
      );
    }

    signalFlushInFlightRef.current = false;

    if (outgoingSignalsRef.current.length > 0) {
      void flushQueuedSignals();
    }
  };

  const scheduleSignalFlush = (delay = SIGNAL_FLUSH_DELAY_MS) => {
    if (signalFlushTimerRef.current) {
      return;
    }

    signalFlushTimerRef.current = window.setTimeout(() => {
      signalFlushTimerRef.current = null;
      void flushQueuedSignals();
    }, delay);
  };

  const queueSignals = (signals: RoomClientSignal[]) => {
    if (signals.length === 0) {
      return;
    }

    outgoingSignalsRef.current.push(...signals);

    if (signals.some((signal) => signal.kind !== "ice")) {
      appendEvent(
        "Signal queued",
        `${signals.length}개 / ${signals.map((signal) => signal.kind).join(", ")}`,
      );
    }

    scheduleSignalFlush();
  };

  const flushPendingIceCandidates = useEffectEvent(
    async (connectionId = activeConnectionIdRef.current) => {
      const peerConnection = peerConnectionRef.current;

      if (!peerConnection || !peerConnection.remoteDescription || !connectionId) {
        return;
      }

      const candidates = pendingIceCandidatesRef.current.filter((entry) => {
        return entry.connectionId === connectionId;
      });

      pendingIceCandidatesRef.current = pendingIceCandidatesRef.current.filter(
        (entry) => entry.connectionId !== connectionId,
      );

      for (const entry of candidates) {
        try {
          await peerConnection.addIceCandidate(entry.candidate);
        } catch {
          pendingIceCandidatesRef.current.push(entry);
        }
      }
    },
  );

  const applyRemoteMatch = useEffectEvent((nextMatch: MatchState) => {
    const normalizedMatch = withDerivedMatchStatus(nextMatch, roomRef.current);

    if (!shouldAdoptRemoteMatch(matchRef.current, normalizedMatch)) {
      return;
    }

    commitMatchState(normalizedMatch);
  });

  const buildMatchFromMove = (
    move: PeerMoveRequest,
    actorColor: RoomPlayer["color"],
  ) => {
    const game = new Chess(matchRef.current.fen);

    if (game.turn() !== toChessColor(actorColor)) {
      return null;
    }

    try {
      const appliedMove = game.move(move);

      return {
        san: appliedMove.san,
        match: {
          fen: game.fen(),
          turn: toRoomColor(game.turn()),
          moveHistory: [...matchRef.current.moveHistory, serializeMove(appliedMove)],
          lastMove: {
            from: appliedMove.from as Square,
            to: appliedMove.to as Square,
          },
          result: getRoomResult(game),
          status: game.isGameOver() ? "finished" : "active",
          updatedAt: new Date().toISOString(),
        } satisfies MatchState,
      };
    } catch {
      return null;
    }
  };

  const sendGameMessage = async (
    message: PeerMessage,
    relaySource: "host-sync" | "guest-move" | "fallback-sync",
  ) => {
    if (sendPeerMessage(message)) {
      appendEvent("Peer sent", `webrtc / ${message.kind}`);
      return {
        ok: true,
        transport: "webrtc" as const,
      };
    }

    const relayed = await postRelayMessage(message, relaySource);

    return {
      ok: relayed,
      transport: relayed ? ("relay" as const) : ("none" as const),
    };
  };

  const syncHostMatch = async (
    nextMatch: MatchState,
    reason: "host-sync" | "fallback-sync" = "host-sync",
  ) => {
    const currentRoom = roomRef.current;
    const activeSession = sessionRef.current;
    const localPlayer = currentRoom?.players.find(
      (entry) => entry.id === activeSession?.playerId,
    );

    if (!currentRoom || !activeSession || localPlayer?.color !== "white") {
      return false;
    }

    const result = await sendGameMessage(
      {
        kind: "match-sync",
        match: withDerivedMatchStatus(nextMatch, currentRoom),
        sentAt: new Date().toISOString(),
      },
      reason,
    );

    if (!result.ok) {
      appendEvent("Host sync failed", reason, "error");
      return false;
    }

    const nextRemotePlayer = chooseRemotePlayer(currentRoom, activeSession.playerId);

    if (nextRemotePlayer?.instanceId) {
      fallbackSyncRef.current = `${nextRemotePlayer.instanceId}:${nextMatch.updatedAt}`;
    }

    return true;
  };

  const resetPeerConnection = (nextStatus: ConnectionStatus = "negotiating") => {
    clearDisconnectRetryTimer();
    if (signalFlushTimerRef.current) {
      window.clearTimeout(signalFlushTimerRef.current);
      signalFlushTimerRef.current = null;
    }

    signalFlushInFlightRef.current = false;
    outgoingSignalsRef.current = [];
    const channel = dataChannelRef.current;

    if (channel) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      dataChannelRef.current = null;

      try {
        channel.close();
      } catch {}
    }

    const peerConnection = peerConnectionRef.current;

    if (peerConnection) {
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.ondatachannel = null;
      peerConnectionRef.current = null;

      try {
        peerConnection.close();
      } catch {}
    }

    pendingIceCandidatesRef.current = [];
    offeredForInstanceRef.current = "";
    activeConnectionIdRef.current = "";
    fallbackSyncRef.current = "";

    if (!roomRef.current || roomRef.current.players.length < 2) {
      setLiveConnectionStatus("waiting-peer");
      return;
    }

    setLiveConnectionStatus(nextStatus);
  };

  const markDisconnected = () => {
    appendEvent("Connection interrupted", "재협상 대기", "warn");
    setLiveConnectionStatus("disconnected");

    if (disconnectRetryTimerRef.current || !roomRef.current) {
      return;
    }

    disconnectRetryTimerRef.current = window.setTimeout(() => {
      disconnectRetryTimerRef.current = null;

      if (
        connectionStatusRef.current === "connected" ||
        !roomRef.current ||
        roomRef.current.players.length < 2
      ) {
        return;
      }

      resetPeerConnection("negotiating");
    }, DISCONNECT_RECOVERY_MS);
  };

  const handleTransportMessage = useEffectEvent(
    async (
      message: PeerMessage,
      source: "webrtc" | "relay",
      senderId?: string,
    ) => {
      const currentRoom = roomRef.current;
      const activeSession = sessionRef.current;
      const localPlayer = currentRoom?.players.find(
        (entry) => entry.id === activeSession?.playerId,
      );

      if (!currentRoom || !activeSession || !localPlayer) {
        return;
      }

      appendEvent("Peer message", `${source} / ${message.kind}`);

      if (message.kind === "match-sync") {
        if (localPlayer.color === "black") {
          applyRemoteMatch(message.match);
          startTransition(() => {
            setErrorMessage("");
          });
        }

        return;
      }

      if (localPlayer.color !== "white") {
        return;
      }

      const remotePlayer = chooseRemotePlayer(currentRoom, activeSession.playerId);

      if (!remotePlayer || (senderId && remotePlayer.id !== senderId)) {
        return;
      }

      const moveResult = buildMatchFromMove(message.move, "black");

      if (!moveResult) {
        appendEvent(
          "Guest move rejected",
          `${message.move.from}-${message.move.to}`,
          "warn",
        );
        await syncHostMatch(matchRef.current, "fallback-sync");
        return;
      }

      commitMatchState(moveResult.match);
      appendEvent(
        "Guest move applied",
        `${moveResult.san} / ${message.move.from}-${message.move.to}`,
      );
      await syncHostMatch(moveResult.match, "host-sync");
    },
  );

  const handlePeerMessage = useEffectEvent((event: MessageEvent<string>) => {
    const rawMessage = event.data;

    try {
      const message = JSON.parse(rawMessage) as PeerMessage;

      if (!message || typeof message !== "object" || typeof message.kind !== "string") {
        return;
      }

      void handleTransportMessage(message, "webrtc");
    } catch {}
  });

  const attachDataChannel = useEffectEvent((channel: RTCDataChannel) => {
    dataChannelRef.current = channel;
    appendEvent("Data channel", `${channel.label} attached`);

    channel.onopen = () => {
      clearDisconnectRetryTimer();
      setLiveConnectionStatus("connected");
      offeredForInstanceRef.current = remoteInstanceRef.current;
      appendEvent("Data channel", `${channel.label} open`);

      void syncHostMatch(matchRef.current, "host-sync");
    };

    channel.onmessage = handlePeerMessage;

    channel.onclose = () => {
      dataChannelRef.current = null;
      appendEvent("Data channel", `${channel.label} close`, "warn");
      markDisconnected();
    };

    channel.onerror = () => {
      appendEvent("Data channel", `${channel.label} error`, "error");
      markDisconnected();
    };
  });

  const createPeerConnection = useEffectEvent(
    (
      remotePlayer: RoomPlayer,
      shouldCreateDataChannel: boolean,
      connectionId: string,
    ) => {
      const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
      peerConnectionRef.current = peerConnection;

      peerConnection.onicecandidate = (event) => {
        if (
          !event.candidate ||
          activeConnectionIdRef.current !== connectionId ||
          peerConnectionRef.current !== peerConnection
        ) {
          return;
        }

        queueSignals([
          {
            connectionId,
            kind: "ice",
            candidate: event.candidate.toJSON(),
          },
        ]);
      };

      peerConnection.onsignalingstatechange = () => {
        appendEvent(
          "Signaling state",
          `${connectionId.slice(0, 8)} / ${peerConnection.signalingState}`,
        );
      };

      peerConnection.onicegatheringstatechange = () => {
        appendEvent(
          "ICE gathering",
          `${connectionId.slice(0, 8)} / ${peerConnection.iceGatheringState}`,
        );
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnectionRef.current !== peerConnection) {
          return;
        }

        appendEvent(
          "Peer connection",
          `${connectionId.slice(0, 8)} / ${peerConnection.connectionState}`,
          peerConnection.connectionState === "failed" ? "error" : "info",
        );

        if (peerConnection.connectionState === "connected") {
          clearDisconnectRetryTimer();
          setLiveConnectionStatus("connected");
          return;
        }

        if (
          peerConnection.connectionState === "connecting" ||
          peerConnection.connectionState === "new"
        ) {
          clearDisconnectRetryTimer();
          setLiveConnectionStatus("negotiating");
          return;
        }

        if (peerConnection.connectionState === "disconnected") {
          markDisconnected();
          return;
        }

        if (peerConnection.connectionState === "failed") {
          resetPeerConnection("disconnected");
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        if (peerConnectionRef.current !== peerConnection) {
          return;
        }

        appendEvent(
          "ICE connection",
          `${connectionId.slice(0, 8)} / ${peerConnection.iceConnectionState}`,
          peerConnection.iceConnectionState === "failed" ? "error" : "info",
        );

        if (peerConnection.iceConnectionState === "failed") {
          resetPeerConnection("disconnected");
          return;
        }

        if (peerConnection.iceConnectionState === "disconnected") {
          markDisconnected();
          return;
        }

        if (
          peerConnection.iceConnectionState === "connected" ||
          peerConnection.iceConnectionState === "completed"
        ) {
          clearDisconnectRetryTimer();
        }
      };

      peerConnection.ondatachannel = (event) => {
        attachDataChannel(event.channel);
      };

      if (shouldCreateDataChannel) {
        const dataChannel = peerConnection.createDataChannel(
          "ryan-chess-match",
          {
            ordered: true,
          },
        );
        attachDataChannel(dataChannel);
      }

      return peerConnection;
    },
  );

  const createAndSendOffer = useEffectEvent(async (nextRoom: RoomSnapshot) => {
    if (!session) {
      return;
    }

    const localPlayer = nextRoom.players.find(
      (entry) => entry.id === session.playerId,
    );
    const remotePlayer = chooseRemotePlayer(nextRoom, session.playerId);

    if (
      !localPlayer ||
      localPlayer.color !== "white" ||
      !remotePlayer ||
      !remotePlayer.instanceId
    ) {
      return;
    }

    if (
      dataChannelRef.current?.readyState === "open" &&
      remotePlayer.instanceId === remoteInstanceRef.current
    ) {
      return;
    }

    if (
      offeredForInstanceRef.current === remotePlayer.instanceId &&
      peerConnectionRef.current
    ) {
      return;
    }

    resetPeerConnection("negotiating");
    const connectionId = crypto.randomUUID();
    activeConnectionIdRef.current = connectionId;
    remoteInstanceRef.current = remotePlayer.instanceId;
    appendEvent(
      "Offer start",
      `${localPlayer.name} -> ${remotePlayer.name} / ${connectionId.slice(0, 8)}`,
    );

    try {
      const peerConnection = createPeerConnection(remotePlayer, true, connectionId);
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const description = serializeDescription(
        peerConnection.localDescription ?? offer,
      );

      if (!description) {
        throw new Error("offer description unavailable");
      }

      const sent = await postSignals(
        [
          {
            connectionId,
            kind: "offer",
            description,
          },
        ],
        "direct",
      );

      if (!sent) {
        resetPeerConnection("disconnected");
        return;
      }

      offeredForInstanceRef.current = remotePlayer.instanceId;
      setLiveConnectionStatus("negotiating");
    } catch {
      resetPeerConnection("disconnected");
      appendEvent("Offer failed", connectionId.slice(0, 8), "error");
      startTransition(() => {
        setErrorMessage("직접 연결을 시작하지 못했습니다.");
      });
    }
  });

  const processSignals = useEffectEvent(
    async (nextRoom: RoomSnapshot, signals: RoomSignal[]) => {
      if (!session) {
        return;
      }

      const localPlayer = nextRoom.players.find(
        (entry) => entry.id === session.playerId,
      );
      const remotePlayer = chooseRemotePlayer(nextRoom, session.playerId);

      if (!localPlayer || !remotePlayer) {
        return;
      }

      if (remotePlayer.instanceId && remotePlayer.instanceId !== remoteInstanceRef.current) {
        const hadPeerConnection =
          !!peerConnectionRef.current || !!dataChannelRef.current;
        remoteInstanceRef.current = remotePlayer.instanceId;
        fallbackSyncRef.current = "";

        if (hadPeerConnection) {
          appendEvent(
            "Remote instance changed",
            remotePlayer.instanceId.slice(0, 8),
            "warn",
          );
          resetPeerConnection("negotiating");
        }
      }

      for (const signal of signals) {
        if (processedSignalIdsRef.current.has(signal.id)) {
          continue;
        }

        processedSignalIdsRef.current.add(signal.id);

        if (processedSignalIdsRef.current.size > 200) {
          processedSignalIdsRef.current = new Set(
            Array.from(processedSignalIdsRef.current).slice(-120),
          );
        }

        if (signal.kind === "offer") {
          appendEvent("Signal received", `offer / ${signal.connectionId.slice(0, 8)}`);
          try {
            resetPeerConnection("negotiating");
            activeConnectionIdRef.current = signal.connectionId;

            const peerConnection = createPeerConnection(
              remotePlayer,
              false,
              signal.connectionId,
            );
            await peerConnection.setRemoteDescription(signal.description);
            await flushPendingIceCandidates(signal.connectionId);

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            const description = serializeDescription(
              peerConnection.localDescription ?? answer,
            );

            if (!description) {
              throw new Error("answer description unavailable");
            }

            await postSignals(
              [
                {
                  connectionId: signal.connectionId,
                  kind: "answer",
                  description,
                },
              ],
              "direct",
            );
            appendEvent("Answer sent", signal.connectionId.slice(0, 8));

            setLiveConnectionStatus("negotiating");
          } catch {
            resetPeerConnection("disconnected");
          }

          continue;
        }

        if (signal.kind === "answer") {
          appendEvent("Signal received", `answer / ${signal.connectionId.slice(0, 8)}`);
          try {
            if (signal.connectionId !== activeConnectionIdRef.current) {
              continue;
            }

            const peerConnection = peerConnectionRef.current;

            if (!peerConnection || !peerConnection.localDescription) {
              continue;
            }

            await peerConnection.setRemoteDescription(signal.description);
            await flushPendingIceCandidates(signal.connectionId);
            setLiveConnectionStatus("negotiating");
          } catch {
            resetPeerConnection("disconnected");
          }

          continue;
        }

        if (signal.kind === "ice") {
          appendEvent("Signal received", `ice / ${signal.connectionId.slice(0, 8)}`);
          if (signal.connectionId !== activeConnectionIdRef.current) {
            pendingIceCandidatesRef.current.push({
              connectionId: signal.connectionId,
              candidate: signal.candidate,
            });
            continue;
          }

          const peerConnection = peerConnectionRef.current;

          if (!peerConnection || !peerConnection.remoteDescription) {
            pendingIceCandidatesRef.current.push({
              connectionId: signal.connectionId,
              candidate: signal.candidate,
            });
            continue;
          }

          try {
            await peerConnection.addIceCandidate(signal.candidate);
          } catch {
            pendingIceCandidatesRef.current.push({
              connectionId: signal.connectionId,
              candidate: signal.candidate,
            });
          }
        }
      }

      if (localPlayer.color === "white" && remotePlayer.instanceId) {
        await createAndSendOffer(nextRoom);
      }
    },
  );

  const processRelayMessages = useEffectEvent(
    async (messages: RoomRelayMessage[]) => {
      for (const entry of messages) {
        if (processedRelayMessageIdsRef.current.has(entry.id)) {
          continue;
        }

        processedRelayMessageIdsRef.current.add(entry.id);

        if (processedRelayMessageIdsRef.current.size > 200) {
          processedRelayMessageIdsRef.current = new Set(
            Array.from(processedRelayMessageIdsRef.current).slice(-120),
          );
        }

        appendEvent(
          "Relay received",
          `${entry.message.kind} / ${entry.id.slice(0, 8)}`,
        );
        await handleTransportMessage(entry.message, "relay", entry.senderId);
      }
    },
  );

  const syncRoom = useEffectEvent(async (force = false) => {
    if (!session) {
      return;
    }

    if (!force && syncingRef.current) {
      return;
    }

    syncingRef.current = true;

    try {
      const snapshot = await requestRoomSync(session, ensureInstanceId());

      if (!snapshot.ok || !snapshot.room) {
        appendEvent(
          "Room sync failed",
          `${snapshot.status} / ${snapshot.error}`,
          "error",
        );
        startTransition(() => {
          setErrorMessage(snapshot.error);
        });

        if (snapshot.status === 404) {
          resetPeerConnection("idle");
          commitRoomSnapshot(null);

          startTransition(() => {
            setSession(null);
          });
        }

        return;
      }

      commitRoomSnapshot(snapshot.room);
      startTransition(() => {
        setErrorMessage("");
      });

      if (snapshot.signals.length > 0 || snapshot.messages.length > 0) {
        appendEvent(
          "Sync received",
          `players ${snapshot.room.players.length} / signals ${snapshot.signals.length} / relay ${snapshot.messages.length}`,
        );
      }

      if (snapshot.room.players.length < 2) {
        if (connectionStatusRef.current !== "waiting-peer") {
          resetPeerConnection("waiting-peer");
        }

        return;
      }

      if (connectionStatusRef.current !== "connected") {
        setLiveConnectionStatus(
          connectionStatusRef.current === "disconnected"
            ? "disconnected"
            : "negotiating",
        );
      }

      await processSignals(snapshot.room, snapshot.signals);
      await processRelayMessages(snapshot.messages);

      const localPlayer = snapshot.room.players.find(
        (entry) => entry.id === session.playerId,
      );
      const nextRemotePlayer = chooseRemotePlayer(snapshot.room, session.playerId);

      if (
        localPlayer?.color === "white" &&
        nextRemotePlayer?.instanceId &&
        connectionStatusRef.current !== "connected"
      ) {
        const fallbackKey = `${nextRemotePlayer.instanceId}:${matchRef.current.updatedAt}`;

        if (fallbackSyncRef.current !== fallbackKey) {
          void syncHostMatch(matchRef.current, "fallback-sync");
        }
      }
    } catch {
      appendEvent("Room sync error", "네트워크 또는 상태 조회 실패", "error");
      startTransition(() => {
        setErrorMessage("방 상태를 동기화하지 못했습니다.");
      });
    } finally {
      syncingRef.current = false;
    }
  });

  useEffect(() => {
    setIsHydrated(true);
    const instanceId = ensureInstanceId();
    appendEvent(
      "RTC config",
      `${ICE_SERVER_COUNT} servers / TURN ${TURN_CONFIGURED ? "on" : "off"}`,
    );
    appendEvent("Client instance", instanceId.slice(0, 8));

    const storedPlayerName = window.localStorage.getItem(ROOM_PLAYER_NAME_KEY);
    const normalizedStoredPlayerName = trimName(storedPlayerName ?? "");

    if (normalizedStoredPlayerName) {
      setPlayerName(normalizedStoredPlayerName);
    }

    const storedSession = window.sessionStorage.getItem(ROOM_SESSION_KEY);
    const inviteCode =
      new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() ??
      "";

    if (!storedSession) {
      if (inviteCode) {
        setJoinCode(inviteCode);
      }

      return;
    }

    try {
      const parsedSession = JSON.parse(storedSession) as RoomSession;

      if (parsedSession.playerName) {
        setPlayerName(trimName(parsedSession.playerName));
      }

      if (inviteCode && parsedSession.roomCode !== inviteCode) {
        window.sessionStorage.removeItem(ROOM_SESSION_KEY);
        window.sessionStorage.removeItem(getMatchStorageKey(parsedSession));
        setJoinCode(inviteCode);

        void fetch(
          `/api/rooms/${parsedSession.roomCode}?playerId=${parsedSession.playerId}`,
          {
            method: "DELETE",
          },
        ).catch(() => null);

        return;
      }

      setSession(parsedSession);
    } catch {
      window.sessionStorage.removeItem(ROOM_SESSION_KEY);
    }

    if (inviteCode) {
      setJoinCode(inviteCode);
    }
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    if (session) {
      window.sessionStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session));
      return;
    }

    window.sessionStorage.removeItem(ROOM_SESSION_KEY);
  }, [isHydrated, session]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    if (!session) {
      const initialMatch = createInitialMatchState();
      matchRef.current = initialMatch;
      setMatch(initialMatch);
      return;
    }

    const storedMatch = window.sessionStorage.getItem(getMatchStorageKey(session));

    if (!storedMatch) {
      const initialMatch = createInitialMatchState();
      matchRef.current = initialMatch;
      setMatch(initialMatch);
      return;
    }

    try {
      const parsedMatch = JSON.parse(storedMatch) as MatchState;
      const normalizedMatch = withDerivedMatchStatus(parsedMatch, roomRef.current);
      matchRef.current = normalizedMatch;
      setMatch(normalizedMatch);
    } catch {
      window.sessionStorage.removeItem(getMatchStorageKey(session));
      const initialMatch = createInitialMatchState();
      matchRef.current = initialMatch;
      setMatch(initialMatch);
    }
  }, [isHydrated, session]);

  useEffect(() => {
    if (!isHydrated || !session) {
      return;
    }

    window.sessionStorage.setItem(
      getMatchStorageKey(session),
      JSON.stringify(match),
    );
  }, [isHydrated, match, session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    appendEvent("Session ready", `${session.roomCode} / ${session.playerId.slice(0, 8)}`);
  }, [session]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }

    const normalizedPlayerName = trimName(playerName);

    if (!normalizedPlayerName) {
      window.localStorage.removeItem(ROOM_PLAYER_NAME_KEY);
      return;
    }

    window.localStorage.setItem(ROOM_PLAYER_NAME_KEY, normalizedPlayerName);
  }, [isHydrated, playerName]);

  useEffect(() => {
    if (!session) {
      return;
    }

    appendEvent("Heartbeat start", session.roomCode);

    const postHeartbeat = async () => {
      try {
        const response = await fetch(`/api/rooms/${session.roomCode}/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            playerId: session.playerId,
            instanceId: ensureInstanceId(),
          }),
        });

        if (!response.ok) {
          appendEvent("Heartbeat failed", session.roomCode, "warn");
          return;
        }
      } catch {
        appendEvent("Heartbeat network error", session.roomCode, "warn");
      }
    };

    void postHeartbeat();

    const intervalId = window.setInterval(() => {
      void postHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [session]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }

      if (disconnectRetryTimerRef.current) {
        window.clearTimeout(disconnectRetryTimerRef.current);
        disconnectRetryTimerRef.current = null;
      }

      if (signalFlushTimerRef.current) {
        window.clearTimeout(signalFlushTimerRef.current);
        signalFlushTimerRef.current = null;
      }

      const channel = dataChannelRef.current;

      if (channel) {
        channel.onopen = null;
        channel.onmessage = null;
        channel.onclose = null;
        channel.onerror = null;
        dataChannelRef.current = null;

        try {
          channel.close();
        } catch {}
      }

      const peerConnection = peerConnectionRef.current;

      if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.ondatachannel = null;
        peerConnectionRef.current = null;

        try {
          peerConnection.close();
        } catch {}
      }
    };
  }, []);

  const activeRoomCode = session?.roomCode;
  const activePlayerId = session?.playerId;

  useEffect(() => {
    if (!activeRoomCode || !activePlayerId) {
      return;
    }

    if (!roomRef.current) {
      setLiveConnectionStatus("negotiating");
    }

    void syncRoom(true);

    const intervalId = window.setInterval(() => {
      void syncRoom();
    }, ROOM_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activePlayerId, activeRoomCode]);

  useEffect(() => {
    if (!activeRoomCode || !activePlayerId || retryNonce === 0) {
      return;
    }

    void syncRoom(true);
  }, [activePlayerId, activeRoomCode, retryNonce]);

  const createRoom = async () => {
    const nextPlayerName = trimName(playerName);
    const instanceId = ensureInstanceId();

    if (!nextPlayerName) {
      setErrorMessage("플레이어 이름을 입력해주세요.");
      return;
    }

    setBusyMode("create");
    setErrorMessage("");
    appendEvent("Room create", nextPlayerName);

    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          playerName: nextPlayerName,
          instanceId,
        }),
      });

      const payload = (await response.json()) as
        | {
            room?: RoomSnapshot;
            playerId?: string;
            error?: string;
          }
        | undefined;

      const nextRoom = payload?.room;
      const nextPlayerId = payload?.playerId;

      if (!response.ok || !nextRoom || !nextPlayerId) {
        setErrorMessage(payload?.error ?? "방을 만들지 못했습니다.");
        return;
      }

      processedSignalIdsRef.current.clear();
      processedRelayMessageIdsRef.current.clear();
      offeredForInstanceRef.current = "";
      remoteInstanceRef.current = "";
      activeConnectionIdRef.current = "";
      fallbackSyncRef.current = "";
      pendingIceCandidatesRef.current = [];
      resetPeerConnection("waiting-peer");
      commitRoomSnapshot(nextRoom);
      setLiveConnectionStatus("waiting-peer");
      appendEvent("Room created", nextRoom.code);

      startTransition(() => {
        setPlayerName(nextPlayerName);
        setJoinCode(nextRoom.code);
        setSession({
          roomCode: nextRoom.code,
          playerId: nextPlayerId,
          playerName: nextPlayerName,
        });
      });
    } catch {
      appendEvent("Room create failed", nextPlayerName, "error");
      setErrorMessage("방을 만들지 못했습니다.");
    } finally {
      setBusyMode(null);
    }
  };

  const joinRoom = async () => {
    const nextPlayerName = trimName(playerName);
    const nextJoinCode = joinCode.trim().toUpperCase();
    const instanceId = ensureInstanceId();

    if (!nextPlayerName) {
      setErrorMessage("플레이어 이름을 입력해주세요.");
      return;
    }

    if (!nextJoinCode) {
      setErrorMessage("입장할 방 코드를 입력해주세요.");
      return;
    }

    setBusyMode("join");
    setErrorMessage("");
    appendEvent("Room join", nextJoinCode);

    try {
      const response = await fetch(`/api/rooms/${nextJoinCode}/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          playerName: nextPlayerName,
          instanceId,
        }),
      });

      const payload = (await response.json()) as
        | {
            room?: RoomSnapshot;
            playerId?: string;
            error?: string;
          }
        | undefined;

      const nextRoom = payload?.room;
      const nextPlayerId = payload?.playerId;

      if (!response.ok || !nextRoom || !nextPlayerId) {
        setErrorMessage(payload?.error ?? "방에 입장하지 못했습니다.");
        return;
      }

      processedSignalIdsRef.current.clear();
      processedRelayMessageIdsRef.current.clear();
      offeredForInstanceRef.current = "";
      remoteInstanceRef.current = "";
      activeConnectionIdRef.current = "";
      fallbackSyncRef.current = "";
      pendingIceCandidatesRef.current = [];
      resetPeerConnection("negotiating");
      commitRoomSnapshot(nextRoom);
      setLiveConnectionStatus("negotiating");
      appendEvent("Room joined", nextRoom.code);

      startTransition(() => {
        setPlayerName(nextPlayerName);
        setJoinCode(nextRoom.code);
        setSession({
          roomCode: nextRoom.code,
          playerId: nextPlayerId,
          playerName: nextPlayerName,
        });
      });
    } catch {
      appendEvent("Room join failed", nextJoinCode, "error");
      setErrorMessage("방에 입장하지 못했습니다.");
    } finally {
      setBusyMode(null);
    }
  };

  const leaveRoom = async () => {
    const activeSession = session;
    appendEvent("Leave room", activeSession?.roomCode ?? "", "warn");

    processedSignalIdsRef.current.clear();
    processedRelayMessageIdsRef.current.clear();
    remoteInstanceRef.current = "";
    offeredForInstanceRef.current = "";
    activeConnectionIdRef.current = "";
    fallbackSyncRef.current = "";
    resetPeerConnection("idle");
    commitRoomSnapshot(null);
    setLiveConnectionStatus("idle");

    if (activeSession) {
      try {
        await fetch(
          `/api/rooms/${activeSession.roomCode}?playerId=${activeSession.playerId}`,
          {
            method: "DELETE",
          },
        );
      } catch {}

      if (isHydrated) {
        window.sessionStorage.removeItem(getMatchStorageKey(activeSession));
      }
    }

    startTransition(() => {
      setSession(null);
      setErrorMessage("");
    });
  };

  const retryConnection = () => {
    if (!session || !room || room.players.length < 2) {
      return;
    }

    appendEvent("Retry connection", room.code, "warn");
    processedSignalIdsRef.current.clear();
    processedRelayMessageIdsRef.current.clear();
    offeredForInstanceRef.current = "";
    activeConnectionIdRef.current = "";
    fallbackSyncRef.current = "";
    pendingIceCandidatesRef.current = [];
    outgoingSignalsRef.current = [];
    resetPeerConnection("negotiating");
    setRetryNonce((current) => current + 1);
  };

  const copyInviteLink = async () => {
    if (!room) {
      return;
    }

    try {
      const inviteUrl = new URL(room.invitePath, window.location.origin);
      await navigator.clipboard.writeText(inviteUrl.toString());
      setCopied(true);
      appendEvent("Invite copied", inviteUrl.toString());

      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }

      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1600);
    } catch {
      setErrorMessage("초대 링크를 복사하지 못했습니다.");
    }
  };

  const handlePieceDrop = ({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }) => {
    if (
      !room ||
      !session ||
      !currentPlayer ||
      !remotePlayer ||
      !targetSquare ||
      !allowDragging
    ) {
      return false;
    }

    const move: PeerMoveRequest = {
      from: sourceSquare as Square,
      to: targetSquare as Square,
      promotion: "q",
    };

    if (currentPlayer.color === "white") {
      const moveResult = buildMatchFromMove(move, "white");

      if (!moveResult) {
        return false;
      }

      commitMatchState(moveResult.match);
      appendEvent(
        "Host move applied",
        `${moveResult.san} / ${sourceSquare}-${targetSquare}`,
      );
      setErrorMessage("");
      void syncHostMatch(moveResult.match, "host-sync");
      return true;
    }

    void sendGameMessage(
      {
        kind: "move-request",
        move,
        sentAt: new Date().toISOString(),
      },
      "guest-move",
    ).then((result) => {
      if (!result.ok) {
        appendEvent("Guest move failed", `${sourceSquare}-${targetSquare}`, "error");
        startTransition(() => {
          setErrorMessage("호스트에게 수 요청을 전달하지 못했습니다.");
        });
        return;
      }

      appendEvent(
        "Guest move requested",
        `${sourceSquare}-${targetSquare} / ${result.transport}`,
      );
      startTransition(() => {
        setErrorMessage("호스트가 수를 검증 중입니다.");
      });
    });

    return false;
  };

  return (
    <section className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.85fr)]">
      <div className="glass-panel p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-stone-300/70">
              Room Match
            </p>
            <h2 className="font-[family:var(--font-display)] text-2xl text-stone-50 sm:text-3xl">
              코드로 친구와 바로 대국하기
            </h2>
          </div>
        </div>

        {session && room ? (
          <>
            <div className="mx-auto w-full max-w-[640px] rounded-[28px] border border-white/10 bg-black/18 p-3 shadow-[0_24px_60px_rgba(0,0,0,0.25)] sm:p-4">
              <Chessboard
                options={{
                  position: match.fen,
                  boardOrientation,
                  onPieceDrop: ({ sourceSquare, targetSquare }) =>
                    handlePieceDrop({
                      sourceSquare,
                      targetSquare: targetSquare ?? null,
                    }),
                  allowDragging,
                  animationDurationInMs: 220,
                  boardStyle: {
                    borderRadius: "22px",
                    boxShadow: "0 18px 45px rgba(0, 0, 0, 0.24)",
                  },
                  darkSquareStyle: {
                    backgroundColor: "#28544b",
                  },
                  lightSquareStyle: {
                    backgroundColor: "#e8d6aa",
                  },
                  squareStyles: buildLastMoveStyles(match.lastMove),
                }}
              />
            </div>
          </>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-[28px] border border-white/10 bg-black/14 p-5">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Create Room
              </p>
              <h3 className="mt-2 font-[family:var(--font-display)] text-2xl text-stone-50">
                새 방 만들기
              </h3>

              <label className="mt-4 grid gap-2">
                <span className="text-sm text-stone-300/82">플레이어 이름</span>
                <input
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                  className="rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-stone-50 outline-none transition placeholder:text-stone-400/70 focus:border-emerald-300/45"
                  placeholder="예: Ryan"
                />
              </label>

              <button
                type="button"
                onClick={() => void createRoom()}
                disabled={busyMode === "create"}
                className="mt-4 w-full rounded-2xl border border-emerald-300/25 bg-emerald-300/12 px-4 py-3 text-sm text-emerald-50 transition hover:bg-emerald-300/18 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busyMode === "create" ? "방 생성 중..." : "방 만들기"}
              </button>
            </div>

            <div className="rounded-[28px] border border-white/10 bg-black/14 p-5">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Join Room
              </p>
              <h3 className="mt-2 font-[family:var(--font-display)] text-2xl text-stone-50">
                코드로 참가
              </h3>

              <label className="mt-4 grid gap-2">
                <span className="text-sm text-stone-300/82">플레이어 이름</span>
                <input
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                  className="rounded-2xl border border-white/10 bg-white/6 px-4 py-3 text-stone-50 outline-none transition placeholder:text-stone-400/70 focus:border-emerald-300/45"
                  placeholder="예: Min"
                />
              </label>

              <label className="mt-4 grid gap-2">
                <span className="text-sm text-stone-300/82">방 코드</span>
                <input
                  value={joinCode}
                  onChange={(event) =>
                    setJoinCode(event.target.value.trim().toUpperCase())
                  }
                  className="rounded-2xl border border-white/10 bg-white/6 px-4 py-3 font-[family:var(--font-mono)] uppercase text-stone-50 outline-none transition placeholder:text-stone-400/70 focus:border-emerald-300/45"
                  placeholder="예: A7K2QX"
                />
              </label>

              <button
                type="button"
                onClick={() => void joinRoom()}
                disabled={busyMode === "join"}
                className="mt-4 w-full rounded-2xl border border-white/12 bg-white/6 px-4 py-3 text-sm text-stone-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busyMode === "join" ? "입장 중..." : "방 참가하기"}
              </button>
            </div>
          </div>
        )}

        {errorMessage ? (
          <div className="mt-4 rounded-2xl border border-rose-300/18 bg-rose-300/10 px-4 py-3 text-sm text-rose-100">
            {errorMessage}
          </div>
        ) : null}

      </div>

      <div className="grid gap-6">
        <div className="glass-panel grid gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-stone-300/65">
                Room Console
              </p>
              <h3 className="mt-2 font-[family:var(--font-display)] text-2xl text-stone-50">
                Match State
              </h3>
            </div>
            <div className="rounded-2xl border border-white/12 bg-white/8 px-3 py-2 text-right text-sm text-stone-200">
              <div className="font-[family:var(--font-mono)] text-lg text-stone-50">
                {room?.code ?? "----"}
              </div>
              <div>{connectionStatus}</div>
            </div>
          </div>

          {session && room ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[28px] border border-white/10 bg-black/14 p-4 sm:col-span-2">
                <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                  Room Code
                </p>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="font-[family:var(--font-mono)] text-3xl text-stone-50">
                    {room.code}
                  </p>
                  <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-xs uppercase tracking-[0.24em] text-stone-300">
                    Match Controls
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => void copyInviteLink()}
                className="rounded-[24px] border border-emerald-300/25 bg-emerald-300/12 px-4 py-4 text-sm text-emerald-50 transition hover:bg-emerald-300/18"
              >
                {copied ? "링크 복사됨" : "초대 링크 복사"}
              </button>

              <button
                type="button"
                onClick={retryConnection}
                className="rounded-[24px] border border-amber-300/20 bg-amber-300/10 px-4 py-4 text-sm text-amber-50 transition hover:bg-amber-300/18"
              >
                연결 다시 시도
              </button>

              <button
                type="button"
                onClick={() => void leaveRoom()}
                className="rounded-[24px] border border-white/12 bg-white/6 px-4 py-4 text-sm text-stone-200 transition hover:bg-white/10 sm:col-span-2"
              >
                세션 나가기
              </button>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[30px] border border-amber-200/28 bg-[linear-gradient(160deg,rgba(255,245,222,0.2),rgba(255,212,134,0.08))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
              <div className="flex items-start justify-between gap-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-amber-100/35 bg-amber-50/16 px-3 py-1 text-[11px] uppercase tracking-[0.28em] text-amber-50">
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-100" />
                  White
                </div>
                {currentPlayer?.id === whitePlayer?.id ? (
                  <div className="rounded-full border border-emerald-200/30 bg-emerald-300/14 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-emerald-50">
                    You
                  </div>
                ) : null}
              </div>

              <div className="mt-4 flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/30 bg-white/75 font-[family:var(--font-display)] text-2xl text-slate-900 shadow-[0_10px_30px_rgba(255,244,214,0.18)]">
                  {getPlayerMonogram(whitePlayer)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] uppercase tracking-[0.28em] text-amber-50/72">
                    Host Seat
                  </p>
                  <p className="mt-1 truncate font-[family:var(--font-display)] text-3xl leading-none text-white">
                    {whitePlayer?.name ?? "대기 중"}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <div className="rounded-full border border-white/18 bg-black/20 px-3 py-1 text-xs text-stone-100">
                  {getPresenceState(whitePlayer)}
                </div>
                <div className="rounded-full border border-white/14 bg-white/10 px-3 py-1 text-xs text-stone-200">
                  {whitePlayer ? "백 진영" : "플레이어 대기"}
                </div>
              </div>
            </div>

            <div className="rounded-[30px] border border-emerald-300/20 bg-[linear-gradient(160deg,rgba(36,98,87,0.45),rgba(7,18,25,0.45))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <div className="flex items-start justify-between gap-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-300/24 bg-emerald-300/12 px-3 py-1 text-[11px] uppercase tracking-[0.28em] text-emerald-50">
                  <span className="h-2.5 w-2.5 rounded-full bg-slate-950 ring-1 ring-white/25" />
                  Black
                </div>
                {currentPlayer?.id === blackPlayer?.id ? (
                  <div className="rounded-full border border-emerald-200/30 bg-emerald-300/14 px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-emerald-50">
                    You
                  </div>
                ) : null}
              </div>

              <div className="mt-4 flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/12 bg-slate-950/86 font-[family:var(--font-display)] text-2xl text-stone-50 shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
                  {getPlayerMonogram(blackPlayer)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] uppercase tracking-[0.28em] text-emerald-100/62">
                    Guest Seat
                  </p>
                  <p className="mt-1 truncate font-[family:var(--font-display)] text-3xl leading-none text-stone-50">
                    {blackPlayer?.name ?? "대기 중"}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <div className="rounded-full border border-white/12 bg-black/24 px-3 py-1 text-xs text-stone-100">
                  {getPresenceState(blackPlayer)}
                </div>
                <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-xs text-stone-200">
                  {blackPlayer ? "흑 진영" : "플레이어 대기"}
                </div>
              </div>
            </div>
            <div
              className={`rounded-3xl p-4 transition ${
                isCurrentPlayerTurn
                  ? "border border-emerald-300/40 bg-[radial-gradient(circle_at_top_left,rgba(109,255,205,0.18),transparent_46%),linear-gradient(180deg,rgba(44,95,78,0.5),rgba(13,32,28,0.82))] shadow-[0_0_0_1px_rgba(132,255,213,0.05),0_0_34px_rgba(74,222,128,0.2),inset_0_1px_0_rgba(255,255,255,0.1)] sm:col-span-2"
                  : "border border-white/10 bg-black/14 sm:col-span-2"
              }`}
            >
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Turn
              </p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-lg text-stone-50">
                    {room ? `${sideLabel(match.turn)} 차례` : "대기 중"}
                  </p>
                  <p
                    className={`mt-1 text-sm ${
                      isCurrentPlayerTurn ? "text-emerald-100" : "text-stone-300/75"
                    }`}
                  >
                    {isCurrentPlayerTurn
                      ? "지금 수를 둘 수 있습니다."
                      : room
                        ? "상대 차례에는 강조가 꺼집니다."
                        : "플레이어 입장을 기다리는 중입니다."}
                  </p>
                </div>
                <div
                  className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs uppercase tracking-[0.24em] ${
                    isCurrentPlayerTurn
                      ? "border border-emerald-200/30 bg-emerald-300/16 text-emerald-50"
                      : "border border-white/10 bg-white/6 text-stone-300"
                  }`}
                >
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${
                      isCurrentPlayerTurn
                        ? "bg-emerald-300 shadow-[0_0_16px_rgba(74,222,128,0.95)]"
                        : "bg-stone-500"
                    }`}
                  />
                  {isCurrentPlayerTurn ? "내 차례" : "대기 중"}
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}
