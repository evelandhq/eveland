import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { TimeZoneProvider } from "@/components/time-zone-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import { Inter } from "next/font/google";
import { cn } from "@/lib/utils";
import { getCurrentMemberOrNull } from "@/lib/server-api";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: {
    default: "Eveland",
    template: "%s | Eveland",
  },
  description: "Self-hosted deployment and operations platform for Eve agents",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const member = await getCurrentMemberOrNull();

  return (
    <html lang="en" className={cn("font-sans", "font-sans", inter.variable)}>
      <body className="antialiased">
        <TooltipProvider>
          <TimeZoneProvider initialTimeZone={member?.displayTimezone ?? null}>
            <AppShell>{children}</AppShell>
          </TimeZoneProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
