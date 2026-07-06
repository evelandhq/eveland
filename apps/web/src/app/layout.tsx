import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Eveland",
  description: "Self-hosted eve runtime control plane",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
