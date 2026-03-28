"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  {
    href: "/",
    label: "Play",
  },
  {
    href: "/about",
    label: "About",
  },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-white/6 bg-[rgba(4,17,24,0.62)] backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-10">
        <Link href="/" className="group flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-300/10 font-[family:var(--font-display)] text-lg text-emerald-100 transition group-hover:bg-emerald-300/16">
            R
          </span>
          <div>
            <p className="font-[family:var(--font-display)] text-xl text-stone-50">
              Ryan Chess
            </p>
            <p className="text-xs uppercase tracking-[0.28em] text-stone-400">
              Play with AI or Friends
            </p>
          </div>
        </Link>

        <nav className="inline-flex items-center rounded-full border border-white/10 bg-black/16 p-1">
          {links.map((link) => {
            const isActive = pathname === link.href;

            return (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-full px-4 py-2 text-sm transition ${
                  isActive
                    ? "bg-emerald-300/18 text-stone-50"
                    : "text-stone-300 hover:text-stone-100"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
