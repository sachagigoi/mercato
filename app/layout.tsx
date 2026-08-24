import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mercato — transferts et rumeurs en direct",
  description:
    "Le feed des transferts, rumeurs et prolongations, avec la probabilité de chaque piste.",
};

export const viewport: Viewport = {
  themeColor: "#0b0f17",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans text-slate-200 antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
