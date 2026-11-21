"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Box, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import clsx from "clsx";

const VIEWERS = [
  { href: "/ifc", label: "IFC", hint: "View, analyse and export IFC / Fragments" },
  { href: "/rvt", label: "RVT", hint: "Open Revit files and export elements as IFC" },
  { href: "/nwd", label: "NWD", hint: "Open Navisworks files and export elements as IFC" },
  { href: "/convert", label: "Convert", hint: "Build IFC files from Revit / Navisworks models, Autodesk Viewer links and floor plans" },
];

export function AppHeader() {
  const pathname = usePathname();
  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b border-line bg-surface px-3">
      <Link href="/ifc" className="flex items-center gap-2 font-semibold tracking-tight text-fg">
        <span className="grid size-6 place-items-center rounded-md bg-accent text-accent-fg">
          <Box size={15} strokeWidth={2.25} />
        </span>
        IFC Studio
      </Link>
      <nav className="flex items-center gap-1" aria-label="Viewers">
        {VIEWERS.map((viewer) => {
          const active = pathname === viewer.href || pathname.startsWith(`${viewer.href}/`);
          return (
            <Link
              key={viewer.href}
              href={viewer.href}
              title={viewer.hint}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors",
                active ? "bg-accent-soft text-accent" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
              )}
            >
              {viewer.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden text-[11.5px] text-fg-3 md:inline">{pathname.startsWith("/nwd") ? "Autodesk Viewer · Platform Services" : pathname.startsWith("/convert") ? "Models and plans to IFC4" : "That Open Engine · Fragments"}</span>
        <ThemeToggle />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("ifc-studio-theme", next ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      aria-label="Toggle theme"
      className="grid size-7 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg"
    >
      {dark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
