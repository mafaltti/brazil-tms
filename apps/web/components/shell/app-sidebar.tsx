"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  BarChart3,
  Building2,
  Container,
  Factory,
  FileCog,
  History,
  LayoutDashboard,
  MapPin,
  Route,
  ScrollText,
  Truck,
  Upload,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { can, type Role } from "@brazil-tms/shared";
import { NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  BarChart3,
  Users,
  ScrollText,
  Building2,
  MapPin,
  Route,
  UserRound,
  Truck,
  Container,
  Factory,
  FileCog,
  Upload,
  History,
};

/**
 * Role-aware navigation. Items are filtered by `can(role, permission)` — hiding is additive only;
 * the BFF stays authoritative (FR-011). Labels come from the `Nav` i18n namespace (SC-006).
 */
export function AppSidebar({ role }: { role: Role }) {
  const t = useTranslations("Nav");
  const tCommon = useTranslations("Common");
  const pathname = usePathname();

  const visibleItems = NAV_ITEMS.filter((item) => !item.permission || can(role, item.permission));

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center border-b px-4 font-semibold">
        {tCommon("appName")}
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {visibleItems.map((item) => {
          const Icon = ICONS[item.icon] ?? LayoutDashboard;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/60",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span>{t(item.key)}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
