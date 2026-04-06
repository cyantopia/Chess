import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About | Ryan Chess",
  description: "Ryan Chess 서비스 소개와 기술 구성",
};

export default function AboutPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-81px)] w-full max-w-7xl flex-col gap-10 px-5 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] lg:items-start">
        <div className="glass-panel overflow-hidden p-6 sm:p-8">
          <div className="inline-flex rounded-full border border-emerald-300/25 bg-emerald-300/12 px-4 py-2 text-xs uppercase tracking-[0.34em] text-emerald-100">
            Next.js x Open Source Chess AI
          </div>

          <div className="mt-6 max-w-3xl">
            <p className="text-sm uppercase tracking-[0.32em] text-stone-300/70">
              Ryan Chess Service
            </p>
            <h1 className="mt-4 max-w-4xl font-[family:var(--font-display)] text-5xl leading-none text-stone-50 sm:text-6xl lg:text-7xl">
              AI와 친구 모두와 둘 수 있는
              <br />
              실전형 웹 서비스
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-stone-200/84 sm:text-lg">
              드래그해서 바로 수를 두고, 브라우저 안에서 돌아가는
              <span className="mx-1 font-[family:var(--font-mono)] text-stone-50">
                Stockfish
              </span>
              엔진과 대전하거나, 방 코드를 만들어 친구와 같은 대국판에서
              WebRTC 직접 연결을 우선 시도하고, 필요하면 Vercel relay로
              이어서 플레이할 수 있도록 구성했습니다.
            </p>
          </div>
        </div>

        <div className="glass-panel grid gap-4 p-6">
          <div>
            <p className="text-xs uppercase tracking-[0.32em] text-stone-300/65">
              Service Snapshot
            </p>
            <h2 className="mt-3 font-[family:var(--font-display)] text-3xl text-stone-50">
              바로 쓸 수 있는 MVP
            </h2>
          </div>

          <div className="grid gap-3">
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-sm text-stone-300/75">체스판 UI</p>
              <p className="mt-2 font-[family:var(--font-mono)] text-lg text-stone-50">
                react-chessboard
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-sm text-stone-300/75">룰 검증</p>
              <p className="mt-2 font-[family:var(--font-mono)] text-lg text-stone-50">
                chess.js
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-sm text-stone-300/75">AI 엔진</p>
              <p className="mt-2 font-[family:var(--font-mono)] text-lg text-stone-50">
                Stockfish 18 Lite
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4">
              <p className="text-sm text-stone-300/75">멀티플레이</p>
              <p className="mt-2 font-[family:var(--font-mono)] text-lg text-stone-50">
                WebRTC P2P Match
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="glass-panel p-6">
          <p className="text-xs uppercase tracking-[0.3em] text-stone-300/65">
            What You Can Do
          </p>
          <h2 className="mt-3 font-[family:var(--font-display)] text-3xl text-stone-50">
            지금 가능한 플레이 방식
          </h2>
          <div className="mt-6 grid gap-3">
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4 text-stone-200">
              AI 모드에서는 난이도를 조절하며 Stockfish와 바로 대국할 수 있습니다.
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4 text-stone-200">
              방 모드에서는 코드를 생성하고 상대를 초대해 호스트 브라우저가
              대국 상태를 관리하며, 직접 연결 또는 Vercel relay로 상태를 공유합니다.
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4 text-stone-200">
              기보, 마지막 수 하이라이트, 턴 상태를 한 화면에서 볼 수 있습니다.
            </div>
          </div>
        </div>

        <div className="glass-panel p-6">
          <p className="text-xs uppercase tracking-[0.3em] text-stone-300/65">
            Notes
          </p>
          <h2 className="mt-3 font-[family:var(--font-display)] text-3xl text-stone-50">
            현재 멀티플레이의 성격
          </h2>
          <div className="mt-6 grid gap-3">
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4 text-stone-200">
              현재 방 기능은 WebRTC DataChannel을 우선 사용하고, 직접 연결이
              어렵더라도 같은 메시지를 Vercel relay polling으로 전달해 대국을
              이어갈 수 있습니다.
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4 text-stone-200">
              TURN 없이도 플레이는 가능하지만, relay보다 직접 연결 성공률을
              높이고 싶다면 나중에 TURN을 추가하는 편이 좋습니다.
            </div>
            <div className="rounded-3xl border border-white/10 bg-black/14 p-4 text-stone-200">
              다음 단계로는 실시간 소켓 동기화, 로그인, 대국 기록 저장을 붙이기 좋습니다.
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
