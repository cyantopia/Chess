"use client";

import { useState } from "react";
import { ChessArena } from "@/components/chess-arena";
import { RoomArena } from "@/components/room-arena";

type PlayMode = "room" | "ai";

export function GameHub() {
  const [mode, setMode] = useState<PlayMode>("room");

  return (
    <section className="grid gap-6">
      <div className="glass-panel flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-stone-300/65">
            Play Modes
          </p>
          <h2 className="mt-2 font-[family:var(--font-display)] text-3xl text-stone-50">
            AI 대전과 방 대전을 오갈 수 있습니다
          </h2>
        </div>

        <div className="inline-flex rounded-full border border-white/10 bg-black/18 p-1">
          <button
            type="button"
            onClick={() => setMode("room")}
            className={`rounded-full px-4 py-2 text-sm transition ${
              mode === "room"
                ? "bg-emerald-300/18 text-stone-50"
                : "text-stone-300 hover:text-stone-100"
            }`}
          >
            방 대전
          </button>
          <button
            type="button"
            onClick={() => setMode("ai")}
            className={`rounded-full px-4 py-2 text-sm transition ${
              mode === "ai"
                ? "bg-emerald-300/18 text-stone-50"
                : "text-stone-300 hover:text-stone-100"
            }`}
          >
            AI 대전
          </button>
        </div>
      </div>

      {mode === "room" ? <RoomArena /> : <ChessArena />}
    </section>
  );
}
