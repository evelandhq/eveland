"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A value you are meant to paste somewhere else — an endpoint, an id — with the
 * one affordance that makes it usable. Reading a URL off the screen and typing
 * it back in is not a thing anyone should have to do.
 */
export function CopyValue({
  className,
  icon = "hover",
  label,
  value,
}: {
  className?: string;
  /**
   * Where copying IS the point — a hero endpoint — the affordance should be
   * standing there, not discovered by hovering. In a dense meta row it is
   * secondary and hiding it until hover keeps the row quiet.
   */
  icon?: "hover" | "always";
  label?: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      aria-label={`Copy ${label ?? value}`}
      className={cn(
        "group/copy flex min-w-0 items-center gap-1.5 text-left hover:text-foreground",
        className,
      )}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
      type="button"
    >
      <span className="min-w-0 break-all">{value}</span>
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-success-foreground" />
      ) : (
        <CopyIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-opacity",
            icon === "hover" && "opacity-0 group-hover/copy:opacity-100",
          )}
        />
      )}
    </button>
  );
}
