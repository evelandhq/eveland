import { cn } from "@/lib/utils";

/**
 * The one place the main area's horizontal rhythm is defined.
 *
 * Every page used to declare its own container, so the insets drifted: three
 * different max-widths, two vertical rhythms, and a project detail page that
 * never widened past `px-5` at any breakpoint. Route to route the content edge
 * visibly jumped. Import this instead of writing the classes again; a page that
 * genuinely wants to be full-bleed simply does not use it.
 *
 * `PAGE_INSET` is the horizontal half on its own, for a full-bleed bar whose
 * rule spans the viewport but whose contents still have to line up with the
 * page below it.
 */
export const PAGE_INSET = "mx-auto w-full max-w-7xl px-5 md:px-8";

export function PageContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn(PAGE_INSET, "flex flex-col py-6", className)}>{children}</div>;
}
