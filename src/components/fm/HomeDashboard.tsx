"use client";

// Home: the facility at a glance (assets and how complete their data is,
// maintenance due, open work orders, alarms) with the next things to do; or,
// before a building is onboarded, the ways to start.

import { Activity, AlertTriangle, Box, BellRing, Building2, CheckCircle2, ClipboardList, FileInput, FileUp, Layers, Package, QrCode, ScanLine, Search, Sparkles, Wrench, FileBox, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { RankedBars } from "@/components/charts/RankedBars";
import { openSearch } from "@/components/shell/SearchPalette";
import { Button } from "@/components/ui/primitives";
import { alarmText } from "@/lib/fm/alarms";
import { fieldLabel, KEY_FIELDS, valueOf } from "@/lib/fm/asset";
import { filterText } from "@/lib/fm/filter";
import { daysBetween, dueState, isOpen, todayIso } from "@/lib/fm/schedule";
import { assetMap, useFm } from "@/lib/fm/store";
import { ago, compact, DueBadge, formatDate, MeterList, Panel, plural, PriorityBadge, StatTile, WoStatusBadge } from "./ui";

export function HomeDashboard() {
  const status = useFm((s) => s.status);
  const facility = useFm((s) => s.facility);
  if (status === "idle" || status === "loading") return <div className="h-full bg-bg" />;
  return facility ? <Dashboard /> : <Welcome />;
}

function Welcome() {
  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[960px] flex-col gap-6 p-4 py-8">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-fg">Welcome to IFC Studio</h1>
          <p className="mt-1 max-w-[80ch] text-[13px] leading-relaxed text-fg-2">
            Turn a building&apos;s models into a maintained asset register: onboard it from its IFC, Revit or Navisworks files, plan maintenance, put QR labels on the equipment, check it on site from a phone, and connect live readings. Everything stays in this browser; share it as files.
          </p>
        </div>
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-3">Facility management</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Start href="/onboard" icon={Building2} title="Onboard a building" text="From model files to assets, rooms, systems and maintenance plans, step by step." primary />
            <Start href="/onboard?demo=1" icon={Sparkles} title="Try the demo building" text="A made-up office building with assets, maintenance, work orders and live readings." />
            <Start href="/settings#workspace" icon={FileUp} title="Open a workspace file" text="A backup of a workspace, or one a colleague exported." />
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-3">Models</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Start href="/ifc" icon={Box} title="IFC viewer" text="View, analyse and export IFC, ifcZIP and Fragments." />
            <Start href="/rvt" icon={FileBox} title="Revit" text="Open Revit files and export elements as IFC." />
            <Start href="/nwd" icon={Layers} title="Navisworks" text="Open Navisworks files and export elements as IFC." />
            <Start href="/convert" icon={FileInput} title="Convert to IFC" text="IFC files and a COBie register from Revit, Navisworks and plans." />
          </div>
        </section>
        <p className="text-[12px] text-fg-3">
          Tip: press <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10.5px]">Ctrl</kbd> <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10.5px]">K</kbd> or{" "}
          <kbd className="rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10.5px]">/</kbd> anywhere to search pages, actions and, once a building is onboarded, its assets, rooms and work orders.
        </p>
      </div>
    </div>
  );
}

function Start({ href, icon: Icon, title, text, primary }: { href: string; icon: LucideIcon; title: string; text: string; primary?: boolean }) {
  return (
    <Link href={href} className={`flex flex-col gap-1.5 rounded-lg border bg-surface p-3 transition-colors hover:border-accent ${primary ? "border-accent/50" : "border-line"}`}>
      <Icon size={17} className="text-accent" />
      <span className="text-[13px] font-semibold text-fg">{title}</span>
      <span className="text-[12px] leading-snug text-fg-3">{text}</span>
    </Link>
  );
}

function Dashboard() {
  const router = useRouter();
  const facility = useFm((s) => s.facility)!;
  const assets = useFm((s) => s.assets);
  const plans = useFm((s) => s.plans);
  const workOrders = useFm((s) => s.workOrders);
  const points = useFm((s) => s.points);
  const alarms = useFm((s) => s.alarms);
  const today = todayIso();

  const figures = useMemo(() => {
    let verified = 0;
    let filled = 0;
    const missing: Record<string, number> = {};
    for (const f of KEY_FIELDS) missing[f] = 0;
    const kinds = new Map<string, number>();
    for (const a of assets) {
      if (a.verified) verified++;
      for (const f of KEY_FIELDS) {
        if (valueOf(a, f)) filled++;
        else missing[f]++;
      }
      kinds.set(a.kind || "Other", (kinds.get(a.kind || "Other") ?? 0) + 1);
    }
    return { verified, completeness: assets.length ? filled / (assets.length * KEY_FIELDS.length) : 0, missing, kinds };
  }, [assets]);

  const due = useMemo(() => {
    let overdue = 0;
    let soon = 0;
    for (const p of plans) {
      const s = dueState(p, today);
      if (s === "overdue") overdue++;
      else if (s === "due") soon++;
    }
    const next = plans.filter((p) => p.active).sort((a, b) => a.nextDue.localeCompare(b.nextDue)).slice(0, 7);
    return { overdue, soon, next };
  }, [plans, today]);

  const open = useMemo(() => workOrders.filter(isOpen).sort((a, b) => a.due.localeCompare(b.due)), [workOrders]);
  const urgent = open.filter((w) => w.priority === "urgent" || w.priority === "high").length;
  const activeAlarms = alarms.filter((a) => a.end === undefined).sort((a, b) => b.start - a.start);
  const reporting = points.filter((p) => p.lastAt && Date.now() - p.lastAt < 15 * 60000).length;
  const byId = assetMap(assets);
  const pointById = new Map(points.map((p) => [p.id, p]));

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-3 sm:p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold tracking-tight text-fg">{facility.name}</h1>
            <p className="mt-0.5 text-[12.5px] text-fg-2">{[facility.site, facility.address].filter(Boolean).join(" · ") || "Facility workspace on this device"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button icon={<Search size={14} />} onClick={() => openSearch()}>
              Search
            </Button>
            <Button icon={<ScanLine size={14} />} onClick={() => router.push("/field?scan=1")}>
              Scan a label
            </Button>
            <Button variant="primary" icon={<Wrench size={14} />} onClick={() => router.push("/maintenance?tab=orders&new=1")}>
              New work order
            </Button>
          </div>
        </div>

        <div className={`grid gap-3 ${points.length ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-2 lg:grid-cols-4"}`}>
          <StatTile label="Assets" icon={Package} value={compact(assets.length)} sub={`${Math.round(figures.completeness * 100)}% of key information filled`} href="/assets" />
          <StatTile label="Checked on site" icon={CheckCircle2} tone={figures.verified ? "ok" : undefined} value={compact(figures.verified)} sub={assets.length ? `${Math.round((figures.verified / assets.length) * 100)}% of assets` : "No assets"} href={`/assets?q=${encodeURIComponent("status:verified")}`} />
          <StatTile
            label="Maintenance overdue"
            icon={AlertTriangle}
            tone={due.overdue ? "bad" : undefined}
            value={compact(due.overdue)}
            sub={due.soon ? `${plural(due.soon, "task")} due in the next 14 days` : plans.length ? "Nothing due in the next 14 days" : "No maintenance plans yet"}
            href="/maintenance?tab=due"
          />
          <StatTile label="Open work orders" icon={ClipboardList} tone={urgent ? "warn" : undefined} value={compact(open.length)} sub={urgent ? `${urgent} urgent or high priority` : open.length ? "None urgent" : "All closed"} href="/maintenance?tab=orders" />
          {points.length ? (
            <StatTile label="Active alarms" icon={BellRing} tone={activeAlarms.length ? "bad" : "ok"} value={compact(activeAlarms.length)} sub={`${reporting} of ${plural(points.length, "point")} reporting`} href="/live?tab=alarms" />
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <Panel
            title="Maintenance due next"
            aside={
              <Link href="/maintenance?tab=due" className="text-[12px] text-accent hover:underline">
                All due
              </Link>
            }
            bodyClassName="p-0"
          >
            {due.next.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-fg-3">
                No maintenance plans yet. <Link href="/maintenance?tab=plans" className="text-accent hover:underline">Set them up</Link> from the task library.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {due.next.map((p) => {
                  const a = byId.get(p.assetId);
                  return (
                    <li key={p.id}>
                      <Link href={`/assets?asset=${encodeURIComponent(p.assetId)}&tab=maintenance`} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] text-fg">{p.title}</div>
                          <div className="truncate text-[11.5px] text-fg-3">{a ? `${a.name} · ${valueOf(a, "floor")}` : p.assetId}</div>
                        </div>
                        <DueBadge state={dueState(p, today)} days={daysBetween(today, p.nextDue)} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel
            title="Open work orders"
            aside={
              <Link href="/maintenance?tab=orders" className="text-[12px] text-accent hover:underline">
                All work orders
              </Link>
            }
            bodyClassName="p-0"
          >
            {open.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-fg-3">No open work orders.</p>
            ) : (
              <ul className="divide-y divide-line">
                {open.slice(0, 7).map((w) => (
                  <li key={w.id}>
                    <Link href={`/maintenance?tab=orders&wo=${encodeURIComponent(w.id)}`} className="flex items-center gap-2 px-3 py-2 hover:bg-surface-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] text-fg">
                          <span className="tabular mr-1.5 text-fg-3">{w.number}</span>
                          {w.title}
                        </div>
                        <div className="truncate text-[11.5px] text-fg-3">
                          Due {formatDate(w.due)}
                          {w.assignee ? ` · ${w.assignee}` : ""}
                        </div>
                      </div>
                      <PriorityBadge priority={w.priority} />
                      <WoStatusBadge status={w.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {points.length ? (
            <Panel
              title="Alarms"
              aside={
                <Link href="/live?tab=alarms" className="text-[12px] text-accent hover:underline">
                  Live data
                </Link>
              }
              bodyClassName="p-0"
            >
              {activeAlarms.length === 0 ? (
                <p className="flex items-center justify-center gap-1.5 px-3 py-6 text-center text-[12px] text-fg-3">
                  <CheckCircle2 size={14} className="text-ok" /> No active alarms.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {activeAlarms.slice(0, 7).map((al) => {
                    const point = pointById.get(al.pointId);
                    const a = al.assetId ? byId.get(al.assetId) : undefined;
                    return (
                      <li key={al.id}>
                        <Link href={a ? `/assets?asset=${encodeURIComponent(a.id)}&tab=live` : "/live?tab=alarms"} className="flex items-start gap-2 px-3 py-2 hover:bg-surface-2">
                          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-bad" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12.5px] text-fg">{alarmText(al, point)}</div>
                            <div className="truncate text-[11.5px] text-fg-3">
                              {a ? `${a.name} · ` : ""}since {ago(al.start)}
                              {al.ackAt ? " · acknowledged" : ""}
                            </div>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          ) : (
            <Panel title="Connect the building">
              <p className="text-[12.5px] leading-relaxed text-fg-2">
                Bring in live readings from the building management system through an MQTT broker (BACnet, Modbus and other systems through a gateway), or import readings from a CSV file. Points are linked to
                assets, and alarms show here.
              </p>
              <div className="mt-3 flex gap-2">
                <Button icon={<Activity size={14} />} onClick={() => router.push("/live?tab=sources&add=mqtt")}>
                  Connect a source
                </Button>
              </div>
            </Panel>
          )}

          <Panel title="Key information filled" className="xl:col-span-2" aside={<span className="text-[11.5px] text-fg-3">Select a row for the assets missing it</span>}>
            <MeterList
              rows={KEY_FIELDS.map((f) => ({
                key: f,
                label: fieldLabel(f === "space" ? "space" : f),
                value: assets.length - figures.missing[f],
                total: assets.length,
                href: `/assets?q=${encodeURIComponent(filterText("missing", f, false))}`,
              }))}
            />
          </Panel>

          <Panel title="Assets by kind" bodyClassName="p-0">
            <RankedBars
              title={`${compact(assets.length)} assets in ${figures.kinds.size} kinds`}
              data={[...figures.kinds].map(([kind, n]) => ({ key: kind, label: kind, value: n }))}
              format={(v) => v.toLocaleString()}
              maxRows={9}
              onPick={(d) => d.key !== "__other" && router.push(`/assets?q=${encodeURIComponent(filterText("kind", d.key))}`)}
            />
          </Panel>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Quick href="/labels" icon={QrCode} title="Print labels" text="QR labels for the assets, to stick on site." />
          <Quick href="/field" icon={ScanLine} title="Field app" text="Scan, check and photograph assets from a phone." />
          <Quick href="/settings#workspace" icon={FileUp} title="Back up or share" text="The whole workspace as one file, or bring one in." />
          <Quick href="/onboard" icon={Building2} title="Onboard again" text="Read updated models into a new workspace." />
        </div>
      </div>
    </div>
  );
}

function Quick({ href, icon: Icon, title, text }: { href: string; icon: LucideIcon; title: string; text: string }) {
  return (
    <Link href={href} className="flex items-start gap-2.5 rounded-lg border border-line bg-surface p-3 transition-colors hover:border-accent/60">
      <Icon size={16} className="mt-0.5 shrink-0 text-accent" />
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-fg">{title}</span>
        <span className="block text-[11.5px] leading-snug text-fg-3">{text}</span>
      </span>
    </Link>
  );
}
