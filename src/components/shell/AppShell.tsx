"use client";

// The frame around every page: the header with the search box, the grouped
// sidebar (icons only when collapsed, a drawer on phones), the phone bar, and
// the facility workspace loaded once for all pages.

import clsx from "clsx";
import { BellRing, Box, Menu as MenuIcon, Moon, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Search, Sun, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { syncLiveSources, stopLive } from "@/lib/fm/live/runtime";
import { dueState, todayIso } from "@/lib/fm/schedule";
import { loadWorkspace, useFm } from "@/lib/fm/store";
import { isActive, NAV, NAV_ITEMS, type NavItem } from "./nav";
import { openSearch, SearchPalette } from "./SearchPalette";
import { syncTheme, toggleTheme, useTheme } from "./theme";

const NAV_KEY = "bimos-nav-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    syncTheme();
    try {
      const saved = localStorage.getItem(NAV_KEY);
      // Collapsed by default on narrower screens, where the 3D viewers need the room.
      setCollapsed(saved !== null ? saved === "1" : window.innerWidth < 1280);
    } catch {
      setCollapsed(window.innerWidth < 1280);
    }
  }, []);
  useEffect(() => setDrawer(false), [pathname]);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      try {
        localStorage.setItem(NAV_KEY, value ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !value;
    });
  };

  return (
    <div className="flex h-dvh flex-col">
      <TopBar onMenu={() => setDrawer(true)} />
      <div className="flex min-h-0 flex-1">
        <aside className={clsx("hidden shrink-0 border-r border-line bg-surface md:flex", collapsed ? "w-[52px]" : "w-[208px]")} aria-label="Main navigation">
          <SideNav collapsed={collapsed} pathname={pathname} onToggle={toggleCollapsed} />
        </aside>
        <main className="min-h-0 min-w-0 flex-1">{children}</main>
      </div>
      <PhoneBar pathname={pathname} onMore={() => setDrawer(true)} />
      {drawer ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/35" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[260px] max-w-[85vw] flex-col border-r border-line bg-surface shadow-pop">
            <div className="flex h-11 items-center justify-between border-b border-line px-3">
              <Brand />
              <button type="button" onClick={() => setDrawer(false)} aria-label="Close navigation" className="grid size-7 place-items-center rounded-md text-fg-2 hover:bg-surface-2">
                <X size={16} />
              </button>
            </div>
            <SideNav collapsed={false} pathname={pathname} />
          </div>
        </div>
      ) : null}
      <SearchPalette />
      <FmBoot />
    </div>
  );
}

/** Loads the facility workspace once and keeps its live sources running. */
function FmBoot() {
  const status = useFm((s) => s.status);
  const sources = useFm((s) => s.sources);
  useEffect(() => {
    void loadWorkspace();
    // Offline use (the field app on site): only in production builds, where file names are stable.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    return () => stopLive();
  }, []);
  useEffect(() => {
    if (status === "ready") syncLiveSources();
  }, [status, sources]);
  return null;
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-fg">
      <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-fg">
        <Box size={15} strokeWidth={2.25} />
      </span>
      IFC Studio
    </Link>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const dark = useTheme((s) => s.dark);
  const facility = useFm((s) => s.facility);
  const alarms = useActiveAlarms();
  const hasPoints = useFm((s) => s.points.length > 0);
  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setShortcut("⌘K");
  }, []);

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 sm:gap-3 sm:px-3">
      <button type="button" onClick={onMenu} aria-label="Open navigation" className="grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 md:hidden">
        <MenuIcon size={17} />
      </button>
      <Brand />
      <button
        type="button"
        onClick={() => openSearch()}
        className="ml-1 hidden h-8 min-w-0 max-w-[460px] flex-1 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-2.5 text-left text-[12.5px] text-fg-3 hover:border-accent/60 hover:text-fg-2 sm:flex"
        aria-label="Search"
        title="Search pages, actions, assets, rooms, systems, work orders and points"
      >
        <Search size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">Search assets, rooms, work orders…</span>
        <kbd className="shrink-0 rounded border border-line-strong bg-surface px-1 font-mono text-[10.5px] text-fg-3">{shortcut}</kbd>
      </button>
      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={() => openSearch()} aria-label="Search" className="grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 sm:hidden">
          <Search size={16} />
        </button>
        {facility ? (
          <Link href="/settings" title="Facility details and workspace" className="hidden max-w-[220px] truncate rounded-md px-2 py-1 text-[12px] font-medium text-fg-2 hover:bg-surface-2 hover:text-fg lg:block">
            {facility.name}
          </Link>
        ) : null}
        {hasPoints ? (
          <Link
            href="/live?tab=alarms"
            title={alarms ? `${alarms} active alarm${alarms === 1 ? "" : "s"} not acknowledged` : "No active alarms"}
            aria-label={alarms ? `${alarms} active alarms` : "Alarms"}
            className={clsx("relative grid size-8 place-items-center rounded-md hover:bg-surface-2", alarms ? "text-bad" : "text-fg-2")}
          >
            <BellRing size={16} />
            {alarms ? <span className="tabular absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-bad px-1 text-center text-[10px] font-semibold leading-4 text-white">{alarms > 99 ? "99+" : alarms}</span> : null}
          </Link>
        ) : null}
        <button
          type="button"
          onClick={toggleTheme}
          title={dark ? "Switch to light theme" : "Switch to dark theme"}
          aria-label="Toggle theme"
          className="grid size-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg"
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}

function useActiveAlarms(): number {
  return useFm((s) => s.alarms.reduce((n, a) => n + (a.end === undefined && !a.ackAt ? 1 : 0), 0));
}

/** Counts shown next to pages: overdue maintenance, active alarms. */
function useBadges(): Record<string, { count: number; tone: "bad" | "warn"; title: string }> {
  const plans = useFm((s) => s.plans);
  const alarms = useActiveAlarms();
  const overdue = useMemo(() => {
    const today = todayIso();
    return plans.reduce((n, p) => n + (dueState(p, today) === "overdue" ? 1 : 0), 0);
  }, [plans]);
  const out: Record<string, { count: number; tone: "bad" | "warn"; title: string }> = {};
  if (overdue) out["/maintenance"] = { count: overdue, tone: "bad", title: `${overdue} maintenance task${overdue === 1 ? "" : "s"} overdue` };
  if (alarms) out["/live"] = { count: alarms, tone: "bad", title: `${alarms} active alarm${alarms === 1 ? "" : "s"}` };
  return out;
}

function SideNav({ collapsed, pathname, onToggle }: { collapsed: boolean; pathname: string; onToggle?: () => void }) {
  const badges = useBadges();
  return (
    <nav className="flex min-h-0 w-full flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
        {NAV.map((group, gi) => (
          <div key={group.label ?? `g${gi}`} className={clsx(gi > 0 && "mt-2")}>
            {group.label ? (
              collapsed ? (
                <div className="mx-2 mb-1 mt-3 h-px bg-line" />
              ) : (
                <div className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-fg-3">{group.label}</div>
              )
            ) : gi > 0 ? (
              <div className="mx-2 mb-2 mt-3 h-px bg-line" />
            ) : null}
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} collapsed={collapsed} badge={badges[item.href]} />
            ))}
          </div>
        ))}
      </div>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className={clsx("flex h-9 shrink-0 items-center gap-2 border-t border-line px-3 text-[12px] text-fg-3 hover:bg-surface-2 hover:text-fg", collapsed && "justify-center px-0")}
          title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          {collapsed ? null : "Collapse"}
        </button>
      ) : null}
    </nav>
  );
}

function NavLink({ item, active, collapsed, badge }: { item: NavItem; active: boolean; collapsed: boolean; badge?: { count: number; tone: "bad" | "warn"; title: string } }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? `${item.label}${badge ? ` (${badge.title})` : ""}` : item.hint}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "relative flex h-8 items-center gap-2.5 rounded-md text-[12.5px] font-medium transition-colors",
        collapsed ? "justify-center" : "px-2",
        active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon size={16} className="shrink-0" />
      {collapsed ? null : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {badge ? (
        collapsed ? (
          <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-bad" aria-label={badge.title} />
        ) : (
          <span title={badge.title} className="tabular rounded-full bg-bad-soft px-1.5 text-[10.5px] font-semibold leading-[18px] text-bad">
            {badge.count > 999 ? "999+" : badge.count}
          </span>
        )
      ) : null}
    </Link>
  );
}

function PhoneBar({ pathname, onMore }: { pathname: string; onMore: () => void }) {
  const items = NAV_ITEMS.filter((i) => i.phone);
  const badges = useBadges();
  const inMore = !items.some((i) => isActive(pathname, i.href));
  return (
    <nav className="flex h-14 shrink-0 items-stretch border-t border-line bg-surface md:hidden" aria-label="Main navigation">
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={clsx("relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium", active ? "text-accent" : "text-fg-3")}>
            <Icon size={19} />
            {item.label === "Field app" ? "Field" : item.label}
            {badges[item.href] ? <span className="absolute right-[calc(50%-16px)] top-2 size-2 rounded-full bg-bad" /> : null}
          </Link>
        );
      })}
      <button type="button" onClick={onMore} className={clsx("flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium", inMore ? "text-accent" : "text-fg-3")}>
        <MoreHorizontal size={19} />
        More
      </button>
    </nav>
  );
}
