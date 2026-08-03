"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

const TimeZoneContext = createContext<string | undefined>(undefined);

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function TimeZoneProvider({
  initialTimeZone,
  children,
}: {
  initialTimeZone: string | null;
  children: React.ReactNode;
}) {
  const [configuredTimeZone, setConfiguredTimeZone] = useState(initialTimeZone);
  const [detectedTimeZone, setDetectedTimeZone] = useState<string | null>(null);

  useEffect(() => {
    setDetectedTimeZone(browserTimezone());
  }, []);

  useEffect(() => {
    setConfiguredTimeZone(initialTimeZone);
  }, [initialTimeZone]);

  useEffect(() => {
    const updateTimeZone = (event: Event) => {
      const member = (event as CustomEvent<{ displayTimezone?: string | null }>).detail;
      if (member && "displayTimezone" in member) {
        setConfiguredTimeZone(member.displayTimezone ?? null);
      }
    };
    window.addEventListener("eveland:profile-updated", updateTimeZone);
    return () => window.removeEventListener("eveland:profile-updated", updateTimeZone);
  }, []);

  const timeZone = configuredTimeZone ?? detectedTimeZone ?? undefined;
  const value = useMemo(() => timeZone, [timeZone]);

  return <TimeZoneContext.Provider value={value}>{children}</TimeZoneContext.Provider>;
}

export function useDisplayTimezone(): string | undefined {
  return useContext(TimeZoneContext);
}
