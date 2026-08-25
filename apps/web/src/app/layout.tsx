import type { Metadata } from "next";
import { TimeZoneProvider } from "@/components/time-zone-provider";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import { getCurrentMemberOrNull } from "@/lib/server-api";

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
    <html lang="en">
      <body className="antialiased">
        <TooltipProvider>
          <TimeZoneProvider initialTimeZone={member?.displayTimezone ?? null}>
            {children}
          </TimeZoneProvider>
        </TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
