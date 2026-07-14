"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function ProjectDeletionPoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => router.refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [active, router]);

  return null;
}
