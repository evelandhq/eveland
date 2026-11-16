import { cn } from "@/lib/utils";

/**
 * The one place the main area's horizontal rhythm is defined.
 *
 * Pages that declare their own container drift apart -- different max-widths,
 * vertical rhythms, and breakpoints -- and the content edge visibly jumps from
 * route to route. Import this instead of writing the classes again; a page that
 * genuinely wants to be full-bleed simply does not use it.
 *
 * `PAGE_INSET` is the horizontal half on its own, for a full-bleed bar whose
 * rule spans the viewport but whose contents still have to line up with the
 * page below it.
 */
export const PAGE_INSET = "mx-auto w-full max-w-7xl px-4 md:px-8";

export function PageContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn(PAGE_INSET, "flex flex-col py-6", className)}>{children}</div>;
}
