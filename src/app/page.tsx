import { GameHub } from "@/components/game-hub";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-81px)] w-full max-w-7xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12">
      <section className="glass-panel flex flex-wrap items-end justify-between gap-5 p-6 sm:p-8">
        <div className="max-w-3xl">
          <p className="text-sm uppercase tracking-[0.32em] text-stone-300/70">
            Ryan Chess Service
          </p>
          <h1 className="mt-3 font-[family:var(--font-display)] text-4xl leading-none text-stone-50 sm:text-5xl">
            플레이에 바로 들어가는 홈
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-stone-200/84">
            소개와 기술 구성은 상단 `About`으로 옮겼습니다. 여기서는 바로 AI
            대전이나 방 대전을 시작할 수 있습니다.
          </p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-black/14 px-5 py-4 text-sm text-stone-200">
          방 생성, 코드 입장, AI 대전 모두 이 화면에서 바로 시작됩니다.
        </div>
      </section>

      <GameHub />
    </main>
  );
}
