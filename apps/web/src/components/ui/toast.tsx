"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The app-wide toast manager. Success feedback for actions whose effect is
 * not (or not obviously) visible on the current page goes through here —
 * previously every action's success path was a bare `router.refresh()`, which
 * silently degrades to no feedback at all when the effect lands elsewhere
 * (#142). Import and call `toastManager.add({ title, description, type })`
 * from any client component; `<Toaster />` in the root layout renders it.
 */
export const toastManager = ToastPrimitive.createToastManager();

function ToastList() {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => (
    <ToastPrimitive.Root
      key={toast.id}
      toast={toast}
      data-slot="toast"
      className={cn(
        "pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-start gap-2.5 rounded-xl border bg-card p-4 text-card-foreground shadow-lg",
        "transition-all duration-300 ease-out data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0",
      )}
    >
      {toast.type === "success" ? (
        <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600" />
      ) : null}
      {toast.type === "error" ? (
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : null}
      <ToastPrimitive.Content className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ToastPrimitive.Title data-slot="toast-title" className="text-sm font-medium" />
        <ToastPrimitive.Description
          data-slot="toast-description"
          className="text-sm text-muted-foreground"
        />
      </ToastPrimitive.Content>
      <ToastPrimitive.Close
        data-slot="toast-close"
        aria-label="Dismiss notification"
        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  ));
}

export function Toaster() {
  return (
    <ToastPrimitive.Provider toastManager={toastManager}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          data-slot="toast-viewport"
          className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col-reverse gap-2 outline-none"
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}
