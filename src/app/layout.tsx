import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TopBar } from "@/components/TopBar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Adds Up",
  description:
    "Reads a balance sheet from a picture and proves each number by re-adding the totals.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-[#f5f7fa] text-slate-900">
        <TopBar />
        <div className="flex-1">{children}</div>
        <footer className="border-t border-slate-200 px-4 py-5 text-center text-xs leading-relaxed text-slate-600">
          Made for the Gemini 4 NYC Hackathon, November 2026. Free, and you do
          not need an account. Company numbers come from public filings at the
          US Securities and Exchange Commission (SEC). Google&apos;s Gemini 4
          models read the balance sheet pictures.
        </footer>
      </body>
    </html>
  );
}
