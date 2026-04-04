"use client";

import { Chess, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import {
  startTransition,
  useDeferredValue,
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
  toChessColor,
  toRoomColor,
  type MatchState,
  type PeerMessage,
  type RoomPlayer,
  type RoomSession,
  type RoomSignal,
  type RoomSnapshot,
  type RoomSync,
} from "@/lib/room-types";

const ROOM_SESSION_KEY = "ryan-chess-room-session";
const ROOM_MATCH_STATE_PREFIX = "ryan-chess-room-match";
const ROOM_PLAYER_NAME_KEY = "ryan-chess-player-name";
const ROOM_POLL_INTERVAL_MS = 1200;
const DISCONNECT_RECOVERY_MS = 3200;
const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
    },
  ],
};

type BusyMode = "create" | "join" | null;
type ConnectionStatus =
  | "idle"
  | "waiting-peer"
  | "negotiating"
  | "connected"
  | "disconnected";

type PendingCandidate = {
  connectionId: string;
  candidate: RTCIceCandidateInit;
};

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

function formatMoveNumber(index: number) {
  return `${Math.floor(index / 2) + 1}.`;
}

function getPresenceState(player?: RoomPlayer) {
  if (!player) {
    return "빈 자리";
  }

  return Date.now() - new Date(player.lastSeenAt).getTime() < 15_000
    ? "온라인"
    : "잠시 비움";
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

function getRoomStatusMessage(
  room: RoomSnapshot | null,
  currentPlayer: RoomPlayer | null,
  match: MatchState,
  connectionStatus: ConnectionStatus,
) {
  if (!room) {
    return "방을 만들거나 코드로 입장해보세요.";
  }

  if (room.players.length < 2) {
    return "상대 플레이어 입장을 기다리는 중입니다.";
  }

  if (!currentPlayer) {
    return "플레이어 정보를 확인하는 중입니다.";
  }

  if (connectionStatus === "negotiating") {
    return "브라우저끼리 직접 연결을 만드는 중입니다.";
  }

  if (connectionStatus === "disconnected") {
    return "연결이 끊겨 다시 협상하는 중입니다.";
  }

  if (connectionStatus !== "connected") {
    return "상대 브라우저 연결을 기다리는 중입니다.";
  }

  if (match.result) {
    return match.result.message;
  }

  return match.turn === currentPlayer.color
    ? "당신 차례입니다."
    : "상대 차례입니다.";
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

  const syncingRef = useRef(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const disconnectRetryTimerRef = useRef<number | null>(null);
  const instanceIdRef = useRef("");
  const roomRef = useRef<RoomSnapshot | null>(null);
  const matchRef = useRef(match);
  const connectionStatusRef = useRef<ConnectionStatus>("idle");
  const offeredForInstanceRef = useRef("");
  const activeConnectionIdRef = useRef("");
  const remoteInstanceRef = useRef("");
  const processedSignalIdsRef = useRef<Set<string>>(new Set());
  const pendingIceCandidatesRef = useRef<PendingCandidate[]>([]);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const deferredHistory = useDeferredValue(match.moveHistory);
  const currentPlayer =
    room?.players.find((entry) => entry.id === session?.playerId) ?? null;
  const whitePlayer = room?.players.find((entry) => entry.color === "white");
  const blackPlayer = room?.players.find((entry) => entry.color === "black");
  const statusMessage = getRoomStatusMessage(
    room,
    currentPlayer,
    match,
    connectionStatus,
  );
  const boardOrientation = currentPlayer?.color ?? "white";
  const allowDragging =
    !!room &&
    !!currentPlayer &&
    connectionStatus === "connected" &&
    match.status === "active" &&
    !match.result &&
    match.turn === currentPlayer.color;

  const ensureInstanceId = () => {
    if (!instanceIdRef.current) {
      instanceIdRef.current = crypto.randomUUID();
    }

    return instanceIdRef.current;
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

  const postSignal = useEffectEvent(
    async (
      signal:
        | {
            connectionId: string;
            kind: "offer" | "answer";
            targetId: string;
            targetInstanceId?: string | null;
            description: RTCSessionDescriptionInit;
          }
        | {
            connectionId: string;
            kind: "ice";
            targetId: string;
            targetInstanceId?: string | null;
            candidate: RTCIceCandidateInit;
          },
    ) => {
      if (!session) {
        return false;
      }

      try {
        const response = await fetch(`/api/rooms/${session.roomCode}/signal`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            playerId: session.playerId,
            targetId: signal.targetId,
            connectionId: signal.connectionId,
            targetInstanceId: signal.targetInstanceId ?? null,
            kind: signal.kind,
            description: "description" in signal ? signal.description : undefined,
            candidate: "candidate" in signal ? signal.candidate : undefined,
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

          return false;
        }

        return true;
      } catch {
        startTransition(() => {
          setErrorMessage("연결 신호를 전달하지 못했습니다.");
        });

        return false;
      }
    },
  );

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

  const resetPeerConnection = (nextStatus: ConnectionStatus = "negotiating") => {
    clearDisconnectRetryTimer();
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

    if (!roomRef.current || roomRef.current.players.length < 2) {
      setLiveConnectionStatus("waiting-peer");
      return;
    }

    setLiveConnectionStatus(nextStatus);
  };

  const markDisconnected = () => {
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

  const handlePeerMessage = useEffectEvent((event: MessageEvent<string>) => {
    const rawMessage = event.data;

    try {
      const message = JSON.parse(rawMessage) as PeerMessage;

      if (!message || typeof message !== "object" || !message.match) {
        return;
      }

      applyRemoteMatch(message.match);
    } catch {}
  });

  const attachDataChannel = useEffectEvent((channel: RTCDataChannel) => {
    dataChannelRef.current = channel;

    channel.onopen = () => {
      clearDisconnectRetryTimer();
      setLiveConnectionStatus("connected");
      offeredForInstanceRef.current = remoteInstanceRef.current;

      void sendPeerMessage({
        kind: "sync",
        match: withDerivedMatchStatus(matchRef.current, roomRef.current),
        sentAt: new Date().toISOString(),
      });
    };

    channel.onmessage = handlePeerMessage;

    channel.onclose = () => {
      dataChannelRef.current = null;
      markDisconnected();
    };

    channel.onerror = () => {
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

        void postSignal({
          connectionId,
          kind: "ice",
          targetId: remotePlayer.id,
          targetInstanceId: remotePlayer.instanceId ?? null,
          candidate: event.candidate.toJSON(),
        });
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnectionRef.current !== peerConnection) {
          return;
        }

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

      const sent = await postSignal({
        connectionId,
        kind: "offer",
        targetId: remotePlayer.id,
        targetInstanceId: remotePlayer.instanceId,
        description,
      });

      if (!sent) {
        resetPeerConnection("disconnected");
        return;
      }

      offeredForInstanceRef.current = remotePlayer.instanceId;
      setLiveConnectionStatus("negotiating");
    } catch {
      resetPeerConnection("disconnected");
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

        if (hadPeerConnection) {
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

            await postSignal({
              connectionId: signal.connectionId,
              kind: "answer",
              targetId: signal.senderId,
              targetInstanceId: signal.senderInstanceId,
              description,
            });

            setLiveConnectionStatus("negotiating");
          } catch {
            resetPeerConnection("disconnected");
          }

          continue;
        }

        if (signal.kind === "answer") {
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
    } catch {
      startTransition(() => {
        setErrorMessage("방 상태를 동기화하지 못했습니다.");
      });
    } finally {
      syncingRef.current = false;
    }
  });

  useEffect(() => {
    setIsHydrated(true);
    ensureInstanceId();

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
    return () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }

      if (disconnectRetryTimerRef.current) {
        window.clearTimeout(disconnectRetryTimerRef.current);
        disconnectRetryTimerRef.current = null;
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

  const createRoom = async () => {
    const nextPlayerName = trimName(playerName);
    const instanceId = ensureInstanceId();

    if (!nextPlayerName) {
      setErrorMessage("플레이어 이름을 입력해주세요.");
      return;
    }

    setBusyMode("create");
    setErrorMessage("");

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
      offeredForInstanceRef.current = "";
      remoteInstanceRef.current = "";
      activeConnectionIdRef.current = "";
      pendingIceCandidatesRef.current = [];
      resetPeerConnection("waiting-peer");
      commitRoomSnapshot(nextRoom);
      setLiveConnectionStatus("waiting-peer");

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
      offeredForInstanceRef.current = "";
      remoteInstanceRef.current = "";
      activeConnectionIdRef.current = "";
      pendingIceCandidatesRef.current = [];
      resetPeerConnection("negotiating");
      commitRoomSnapshot(nextRoom);
      setLiveConnectionStatus("negotiating");

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
      setErrorMessage("방에 입장하지 못했습니다.");
    } finally {
      setBusyMode(null);
    }
  };

  const leaveRoom = async () => {
    const activeSession = session;

    processedSignalIdsRef.current.clear();
    remoteInstanceRef.current = "";
    offeredForInstanceRef.current = "";
    activeConnectionIdRef.current = "";
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

  const copyInviteLink = async () => {
    if (!room) {
      return;
    }

    try {
      const inviteUrl = new URL(room.invitePath, window.location.origin);
      await navigator.clipboard.writeText(inviteUrl.toString());
      setCopied(true);

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
    if (!room || !session || !currentPlayer || !targetSquare || !allowDragging) {
      return false;
    }

    const nextGame = new Chess(match.fen);

    if (nextGame.turn() !== toChessColor(currentPlayer.color)) {
      return false;
    }

    try {
      const appliedMove = nextGame.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });

      const nextMatch: MatchState = {
        fen: nextGame.fen(),
        turn: toRoomColor(nextGame.turn()),
        moveHistory: [...match.moveHistory, serializeMove(appliedMove)],
        lastMove: {
          from: appliedMove.from as Square,
          to: appliedMove.to as Square,
        },
        result: getRoomResult(nextGame),
        status: nextGame.isGameOver() ? "finished" : "active",
        updatedAt: new Date().toISOString(),
      };

      const sent = sendPeerMessage({
        kind: "move",
        match: nextMatch,
        sentAt: nextMatch.updatedAt,
      });

      if (!sent) {
        setErrorMessage("상대 브라우저와 연결되지 않아 수를 보낼 수 없습니다.");
        return false;
      }

      commitMatchState(nextMatch);
      setErrorMessage("");
      return true;
    } catch {
      return false;
    }
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

          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-2 text-sm text-stone-100">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                connectionStatus === "connected"
                  ? "bg-emerald-300"
                  : "bg-amber-300"
              }`}
            />
            {statusMessage}
          </div>
        </div>

        {session && room ? (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
                <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                  Room Code
                </p>
                <p className="mt-2 font-[family:var(--font-mono)] text-3xl text-stone-50">
                  {room.code}
                </p>
              </div>

              <button
                type="button"
                onClick={() => void copyInviteLink()}
                className="rounded-3xl border border-emerald-300/25 bg-emerald-300/12 px-5 py-4 text-sm text-emerald-50 transition hover:bg-emerald-300/18"
              >
                {copied ? "링크 복사됨" : "초대 링크 복사"}
              </button>

              <button
                type="button"
                onClick={() => void leaveRoom()}
                className="rounded-3xl border border-white/12 bg-white/6 px-5 py-4 text-sm text-stone-200 transition hover:bg-white/10"
              >
                세션 나가기
              </button>
            </div>

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

        <p className="mt-4 text-sm leading-6 text-stone-300/82">
          현재 방 대전은 브라우저끼리 직접 연결하는 WebRTC DataChannel 기반입니다.
          Vercel은 방 생성과 offer/answer/ICE 교환용 signaling만 맡고, 실제
          수순은 두 클라이언트가 직접 주고받습니다. 일부 제한적인 네트워크에서는
          TURN 서버가 없으면 연결이 어려울 수 있습니다.
        </p>
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

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                White
              </p>
              <p className="mt-2 text-lg text-stone-50">
                {whitePlayer?.name ?? "대기 중"}
              </p>
              <p className="mt-1 text-sm text-stone-300/80">
                {getPresenceState(whitePlayer)}
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Black
              </p>
              <p className="mt-2 text-lg text-stone-50">
                {blackPlayer?.name ?? "대기 중"}
              </p>
              <p className="mt-1 text-sm text-stone-300/80">
                {getPresenceState(blackPlayer)}
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                You
              </p>
              <p className="mt-2 text-lg text-stone-50">
                {currentPlayer
                  ? `${currentPlayer.name} (${sideLabel(currentPlayer.color)})`
                  : "미참가"}
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Turn
              </p>
              <p className="mt-2 text-lg text-stone-50">
                {room ? `${sideLabel(match.turn)} 차례` : "대기 중"}
              </p>
            </div>
          </div>
        </div>

        <div className="glass-panel p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-stone-300/65">
                Move List
              </p>
              <h3 className="mt-2 font-[family:var(--font-display)] text-2xl text-stone-50">
                Shared Game Score
              </h3>
            </div>
            <div className="rounded-full border border-white/10 bg-white/8 px-3 py-2 font-[family:var(--font-mono)] text-sm text-stone-200">
              {deferredHistory.length} half-moves
            </div>
          </div>

          <div className="mt-4 max-h-[360px] overflow-y-auto rounded-[24px] border border-white/10 bg-black/14 p-3">
            {deferredHistory.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm leading-6 text-stone-300/72">
                직접 연결이 완료되면 여기부터 공동 기보가 쌓입니다.
              </div>
            ) : (
              <div className="grid gap-2">
                {Array.from(
                  { length: Math.ceil(deferredHistory.length / 2) },
                  (_, index) => {
                    const whiteMove = deferredHistory[index * 2];
                    const blackMove = deferredHistory[index * 2 + 1];

                    return (
                      <div
                        key={`${index}-${whiteMove?.san ?? "opening"}`}
                        className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 rounded-2xl border border-white/6 bg-white/5 px-3 py-2 text-sm text-stone-100"
                      >
                        <span className="font-[family:var(--font-mono)] text-stone-400">
                          {formatMoveNumber(index * 2)}
                        </span>
                        <span className="truncate">{whiteMove?.san ?? "..."}</span>
                        <span className="truncate text-stone-300">
                          {blackMove?.san ?? ""}
                        </span>
                      </div>
                    );
                  },
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
