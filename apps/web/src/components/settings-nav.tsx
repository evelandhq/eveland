"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ShieldUserIcon, UsersIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const groups = [
  {
    label: "Personal",
    items: [{ href: "/settings/profile", label: "Profile", icon: ShieldUserIcon }],
  },
  {
    label: "System",
    items: [{ href: "/settings/members", label: "Members", icon: UsersIcon }],
  },
] as const

export function SettingsNav() {
  const pathname = usePathname()

  return (
    <nav aria-label="Settings" className="flex gap-6 overflow-x-auto md:flex-col md:gap-7">
      {groups.map((group) => (
        <div key={group.label} className="flex min-w-36 flex-col gap-1">
          <p className="px-2 text-xs font-medium text-muted-foreground">{group.label}</p>
          {group.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                buttonVariants({ variant: pathname === item.href ? "secondary" : "ghost", size: "sm" }),
                "justify-start",
              )}
            >
              <item.icon data-icon="inline-start" />
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}
