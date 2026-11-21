// The app's pages, grouped as the sidebar shows them. The sidebar, the phone
// bar and the search palette all read this list, so a page added here can be
// reached from everywhere.

import { Activity, Box, Building2, FileInput, House, Layers, type LucideIcon, Package, QrCode, Settings, Smartphone, Wrench, FileBox } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** What the page is for (tooltips, search results). */
  hint: string;
  /** More words the page is found by in search. */
  keywords?: string;
  /** Shown in the phone bar. */
  phone?: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/", label: "Home", icon: House, hint: "The facility at a glance: assets, maintenance due, work orders, alarms", keywords: "dashboard overview start", phone: true }],
  },
  {
    label: "Facility",
    items: [
      { href: "/assets", label: "Assets", icon: Package, hint: "The asset register: search, filter, open, edit, verify and export", keywords: "register equipment inventory cafm cobie", phone: true },
      { href: "/maintenance", label: "Maintenance", icon: Wrench, hint: "Due list, calendar, work orders and maintenance plans", keywords: "ppm planned preventive work orders calendar tasks schedule", phone: true },
      { href: "/live", label: "Live data", icon: Activity, hint: "Readings from the building's systems, points on assets, alarms", keywords: "iot bms mqtt sensors points alarms connected brick" },
      { href: "/labels", label: "Labels", icon: QrCode, hint: "QR labels for assets, ready to print", keywords: "qr print tags barcode stickers" },
      { href: "/field", label: "Field app", icon: Smartphone, hint: "The phone view for technicians: scan a label, check, record", keywords: "mobile scan technician site survey verify", phone: true },
    ],
  },
  {
    label: "Onboarding",
    items: [{ href: "/onboard", label: "Onboard a building", icon: Building2, hint: "From model files to a maintained asset register, step by step", keywords: "wizard setup import new facility handover" }],
  },
  {
    label: "Models",
    items: [
      { href: "/ifc", label: "IFC viewer", icon: Box, hint: "View, analyse and export IFC, ifcZIP and Fragments models", keywords: "3d model viewer fragments" },
      { href: "/rvt", label: "Revit", icon: FileBox, hint: "Open Revit files and export elements as IFC", keywords: "rvt rfa autodesk" },
      { href: "/nwd", label: "Navisworks", icon: Layers, hint: "Open Navisworks files and export elements as IFC", keywords: "nwd nwc autodesk viewer" },
      { href: "/convert", label: "Convert to IFC", icon: FileInput, hint: "Build IFC files and an asset register from Revit, Navisworks, viewer links and plans", keywords: "convert export ifc cobie floor plans" },
    ],
  },
  {
    label: null,
    items: [{ href: "/settings", label: "Settings", icon: Settings, hint: "Facility details, the workspace file, labels and this device", keywords: "preferences backup export import workspace storage" }],
  },
];

export const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

/** Whether a nav item is the page at `pathname`. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
