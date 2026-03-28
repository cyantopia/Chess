"use client";

import { Chess, type Color, type Move, type Square } from "chess.js";
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

type PlayerColor = "white" | "black";

type EngineScore =
  | {
      kind: "cp";
      value: number;
    }
  | {
      kind: "mate";
      value: number;
    }
  | null;

const STOCKFISH_SCRIPT = "/stockfish/stockfish-18-lite-single.js";
const START_FEN = new Chess().fen();

function toChessColor(color: PlayerColor): Color {
  return color === "white" ? "w" : "b";
}

function opponent(color: PlayerColor): PlayerColor {
  return color === "white" ? "black" : "white";
}

function sideLabel(color: PlayerColor | Color): string {
  return color === "white" || color === "w" ? "백" : "흑";
}

function getMoveTimeMs(skillLevel: number): number {
  return 220 + skillLevel * 55;
}

function getStrengthLabel(skillLevel: number): string {
  if (skillLevel <= 5) {
    return "입문";
  }

  if (skillLevel <= 12) {
    return "균형";
  }

  return "매우 강함";
}

function parseEngineScore(message: string): EngineScore {
  const mateMatch = message.match(/ score mate (-?\d+)/);

  if (mateMatch) {
    return {
      kind: "mate",
      value: Number(mateMatch[1]),
    };
  }

  const cpMatch = message.match(/ score cp (-?\d+)/);

  if (cpMatch) {
    return {
      kind: "cp",
      value: Number(cpMatch[1]),
    };
  }

  return null;
}

function parsePrincipalVariation(message: string): string {
  const pvMatch = message.match(/ pv (.+)$/);
  return pvMatch?.[1]?.trim() ?? "";
}

function parseBestMove(message: string): string | null {
  const bestMoveMatch = message.match(/^bestmove\s+(\S+)/);
  return bestMoveMatch?.[1] ?? null;
}

function formatEngineScore(score: EngineScore): string {
  if (!score) {
    return "분석 대기";
  }

  if (score.kind === "mate") {
    return `M${score.value}`;
  }

  const pawns = score.value / 100;
  return `${pawns >= 0 ? "+" : ""}${pawns.toFixed(1)}`;
}

function buildLastMoveStyles(lastMove: [Square, Square] | null) {
  if (!lastMove) {
    return {};
  }

  const highlight: CSSProperties = {
    background:
      "linear-gradient(135deg, rgba(255, 199, 95, 0.68), rgba(255, 231, 177, 0.3))",
  };

  return {
    [lastMove[0]]: highlight,
    [lastMove[1]]: highlight,
  } satisfies Record<string, CSSProperties>;
}

function getStatusMessage(
  game: Chess,
  humanColor: PlayerColor,
  thinking: boolean,
  engineReady: boolean,
) {
  if (!engineReady) {
    return "Stockfish 엔진을 깨우는 중입니다.";
  }

  if (game.isCheckmate()) {
    return game.turn() === toChessColor(humanColor)
      ? "체크메이트. AI가 승리했습니다."
      : "체크메이트. 당신이 승리했습니다.";
  }

  if (game.isStalemate()) {
    return "스테일메이트로 무승부입니다.";
  }

  if (game.isThreefoldRepetition()) {
    return "같은 포지션이 세 번 반복되어 무승부입니다.";
  }

  if (game.isInsufficientMaterial()) {
    return "기물이 부족해 무승부입니다.";
  }

  if (game.isDrawByFiftyMoves()) {
    return "50수 규칙으로 무승부입니다.";
  }

  if (thinking) {
    return "AI가 수를 계산하고 있습니다.";
  }

  if (game.turn() === toChessColor(humanColor)) {
    return game.inCheck()
      ? "당신 차례입니다. 현재 체크 상태입니다."
      : "당신 차례입니다.";
  }

  return game.inCheck()
    ? "AI 차례입니다. AI가 체크를 받았습니다."
    : "AI 차례입니다.";
}

function formatMoveNumber(index: number) {
  return `${Math.floor(index / 2) + 1}.`;
}

export function ChessArena() {
  const [humanColor, setHumanColor] = useState<PlayerColor>("white");
  const [skillLevel, setSkillLevel] = useState(9);
  const [fen, setFen] = useState(START_FEN);
  const [moveHistory, setMoveHistory] = useState<Move[]>([]);
  const [lastMove, setLastMove] = useState<[Square, Square] | null>(null);
  const [thinking, setThinking] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [engineScore, setEngineScore] = useState<EngineScore>(null);
  const [principalVariation, setPrincipalVariation] = useState("");
  const [engineBootKey, setEngineBootKey] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const fenRef = useRef(fen);
  const humanColorRef = useRef(humanColor);
  const skillLevelRef = useRef(skillLevel);
  const pendingFenRef = useRef<string | null>(null);

  const deferredHistory = useDeferredValue(moveHistory);

  const game = new Chess(fen);
  const aiColor = opponent(humanColor);
  const statusMessage = getStatusMessage(game, humanColor, thinking, engineReady);
  const allowDragging =
    engineReady &&
    !thinking &&
    !game.isGameOver() &&
    game.turn() === toChessColor(humanColor);

  useEffect(() => {
    fenRef.current = fen;
  }, [fen]);

  useEffect(() => {
    humanColorRef.current = humanColor;
  }, [humanColor]);

  useEffect(() => {
    skillLevelRef.current = skillLevel;
  }, [skillLevel]);

  const handleWorkerMessage = useEffectEvent((rawMessage: string) => {
    const message = rawMessage.trim();

    if (!message) {
      return;
    }

    if (message === "uciok") {
      workerRef.current?.postMessage(
        `setoption name Skill Level value ${skillLevelRef.current}`,
      );
      workerRef.current?.postMessage("isready");
      return;
    }

    if (message === "readyok") {
      setEngineReady(true);
      return;
    }

    if (message.startsWith("info ")) {
      const nextScore = parseEngineScore(message);
      const nextPv = parsePrincipalVariation(message);

      if (nextScore) {
        setEngineScore(nextScore);
      }

      if (nextPv) {
        setPrincipalVariation(nextPv);
      }

      return;
    }

    if (!message.startsWith("bestmove")) {
      return;
    }

    const pendingFen = pendingFenRef.current;
    const bestMove = parseBestMove(message);

    pendingFenRef.current = null;
    setThinking(false);

    if (!pendingFen || !bestMove || bestMove === "(none)") {
      return;
    }

    if (fenRef.current !== pendingFen) {
      return;
    }

    const nextGame = new Chess(pendingFen);

    try {
      const appliedMove = nextGame.move({
        from: bestMove.slice(0, 2),
        to: bestMove.slice(2, 4),
        promotion: bestMove[4] ?? "q",
      });

      startTransition(() => {
        setFen(nextGame.fen());
        setMoveHistory(nextGame.history({ verbose: true }));
        setLastMove([appliedMove.from, appliedMove.to]);
      });
    } catch {
      pendingFenRef.current = null;
    }
  });

  const requestEngineMove = useEffectEvent(() => {
    const worker = workerRef.current;
    const currentGame = new Chess(fenRef.current);

    if (!worker || !engineReady || thinking || currentGame.isGameOver()) {
      return;
    }

    if (currentGame.turn() === toChessColor(humanColorRef.current)) {
      return;
    }

    pendingFenRef.current = currentGame.fen();
    setThinking(true);
    setEngineScore(null);
    setPrincipalVariation("");

    worker.postMessage(`position fen ${currentGame.fen()}`);
    worker.postMessage(`go movetime ${getMoveTimeMs(skillLevelRef.current)}`);
  });

  useEffect(() => {
    pendingFenRef.current = null;

    const worker = new Worker(STOCKFISH_SCRIPT);
    workerRef.current = worker;

    worker.onmessage = (event) => {
      handleWorkerMessage(String(event.data));
    };

    worker.postMessage("uci");

    return () => {
      pendingFenRef.current = null;

      try {
        worker.postMessage("quit");
      } catch {}

      worker.terminate();

      if (workerRef.current === worker) {
        workerRef.current = null;
      }
    };
  }, [engineBootKey]);

  useEffect(() => {
    if (!engineReady || !workerRef.current) {
      return;
    }

    workerRef.current.postMessage(
      `setoption name Skill Level value ${skillLevel}`,
    );
    workerRef.current.postMessage("isready");
  }, [engineReady, skillLevel]);

  useEffect(() => {
    requestEngineMove();
  }, [engineReady, fen, humanColor, skillLevel, thinking]);

  const startNewGame = (nextHumanColor: PlayerColor) => {
    pendingFenRef.current = null;

    startTransition(() => {
      setHumanColor(nextHumanColor);
      setFen(START_FEN);
      setMoveHistory([]);
      setLastMove(null);
      setThinking(false);
      setEngineReady(false);
      setEngineScore(null);
      setPrincipalVariation("");
    });

    // 새 워커를 띄워 이전 탐색에서 늦게 도착하는 bestmove를 차단합니다.
    setEngineBootKey((current) => current + 1);
  };

  const handlePieceDrop = ({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }) => {
    const currentGame = new Chess(fenRef.current);

    if (
      !targetSquare ||
      !engineReady ||
      thinking ||
      currentGame.isGameOver() ||
      currentGame.turn() !== toChessColor(humanColorRef.current)
    ) {
      return false;
    }

    try {
      const appliedMove = currentGame.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });

      startTransition(() => {
        setFen(currentGame.fen());
        setMoveHistory(currentGame.history({ verbose: true }));
        setLastMove([appliedMove.from, appliedMove.to]);
        setEngineScore(null);
        setPrincipalVariation("");
      });

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
              Live Match
            </p>
            <h2 className="font-[family:var(--font-display)] text-2xl text-stone-50 sm:text-3xl">
              Ryan vs Stockfish
            </h2>
          </div>

          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-2 text-sm text-stone-100">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                thinking ? "animate-pulse bg-amber-300" : "bg-emerald-300"
              }`}
            />
            {statusMessage}
          </div>
        </div>

        <div className="mx-auto w-full max-w-[640px] rounded-[28px] border border-white/10 bg-black/18 p-3 shadow-[0_24px_60px_rgba(0,0,0,0.25)] sm:p-4">
          <Chessboard
            options={{
              position: fen,
              boardOrientation: humanColor,
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
              squareStyles: buildLastMoveStyles(lastMove),
            }}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => startNewGame("white")}
            className={`rounded-2xl border px-4 py-3 text-sm transition ${
              humanColor === "white"
                ? "border-emerald-300/60 bg-emerald-300/16 text-stone-50"
                : "border-white/12 bg-white/6 text-stone-200 hover:border-white/20 hover:bg-white/10"
            }`}
          >
            백으로 시작
          </button>
          <button
            type="button"
            onClick={() => startNewGame("black")}
            className={`rounded-2xl border px-4 py-3 text-sm transition ${
              humanColor === "black"
                ? "border-emerald-300/60 bg-emerald-300/16 text-stone-50"
                : "border-white/12 bg-white/6 text-stone-200 hover:border-white/20 hover:bg-white/10"
            }`}
          >
            흑으로 시작
          </button>
          <button
            type="button"
            onClick={() => startNewGame(humanColor)}
            className="rounded-2xl border border-amber-200/20 bg-amber-200/10 px-4 py-3 text-sm text-amber-100 transition hover:border-amber-200/30 hover:bg-amber-200/14"
          >
            같은 진영으로 다시
          </button>
        </div>

        <p className="mt-4 text-sm leading-6 text-stone-300/82">
          폰이 마지막 줄에 도달하면 자동으로 퀸으로 승급합니다. AI는
          {` `}
          <span className="font-[family:var(--font-mono)] text-stone-100">
            Stockfish 18 Lite
          </span>
          {` `}
          엔진으로 계산합니다.
        </p>
      </div>

      <div className="grid gap-6">
        <div className="glass-panel grid gap-4 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-stone-300/65">
                Engine Control
              </p>
              <h3 className="mt-2 font-[family:var(--font-display)] text-2xl text-stone-50">
                Match Console
              </h3>
            </div>
            <div className="rounded-2xl border border-white/12 bg-white/8 px-3 py-2 text-right text-sm text-stone-200">
              <div className="font-[family:var(--font-mono)] text-lg text-stone-50">
                {skillLevel}
              </div>
              <div>{getStrengthLabel(skillLevel)}</div>
            </div>
          </div>

          <label className="grid gap-3">
            <span className="flex items-center justify-between text-sm text-stone-200">
              <span>AI 난이도</span>
              <span className="font-[family:var(--font-mono)] text-stone-50">
                약 {getMoveTimeMs(skillLevel)}ms
              </span>
            </span>
            <input
              type="range"
              min="1"
              max="20"
              value={skillLevel}
              onChange={(event) => setSkillLevel(Number(event.target.value))}
              className="accent-emerald-300"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Player
              </p>
              <p className="mt-2 text-lg text-stone-50">
                당신은 {sideLabel(humanColor)}
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                AI
              </p>
              <p className="mt-2 text-lg text-stone-50">
                Stockfish는 {sideLabel(aiColor)}
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Turn
              </p>
              <p className="mt-2 text-lg text-stone-50">
                현재 {sideLabel(game.turn())} 차례
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
                Eval
              </p>
              <p className="mt-2 font-[family:var(--font-mono)] text-lg text-stone-50">
                {formatEngineScore(engineScore)}
              </p>
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
            <p className="text-xs uppercase tracking-[0.28em] text-stone-300/65">
              Principal Variation
            </p>
            <p className="mt-3 min-h-12 font-[family:var(--font-mono)] text-sm leading-6 text-stone-200/90">
              {principalVariation || "AI가 탐색을 시작하면 예상 수순이 표시됩니다."}
            </p>
          </div>
        </div>

        <div className="glass-panel p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-stone-300/65">
                Move List
              </p>
              <h3 className="mt-2 font-[family:var(--font-display)] text-2xl text-stone-50">
                Game Score
              </h3>
            </div>
            <div className="rounded-full border border-white/10 bg-white/8 px-3 py-2 font-[family:var(--font-mono)] text-sm text-stone-200">
              {deferredHistory.length} half-moves
            </div>
          </div>

          <div className="mt-4 max-h-[360px] overflow-y-auto rounded-[24px] border border-white/10 bg-black/14 p-3">
            {deferredHistory.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm leading-6 text-stone-300/72">
                첫 수를 두면 여기에 기보가 쌓입니다.
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
