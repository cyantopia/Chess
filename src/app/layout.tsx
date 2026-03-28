import type { Metadata } from "next";
import { SiteNav } from "@/components/site-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ryan Chess",
  description: "Next.js로 만든 Stockfish 기반 AI 체스 대전 서비스",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <div className="relative min-h-screen">
          <SiteNav />
          {children}
        </div>
      </body>
    </html>
  );
}
