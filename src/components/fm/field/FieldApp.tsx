"use client";

// The field app: the phone view for technicians on site. Scan an asset's
// label (or search), see what it is and where, fill in what is missing,
// confirm it, photograph it, report a fault, close work; then share the
// changes as a file for the main workspace. Works without signal once opened.

import clsx from "clsx";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, ChevronRight, CloudOff, History, RefreshCw, ScanLine, Search, Share2, Upload, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Callout } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { KEY_FIELDS, statusOf, valueOf } from "@/lib/fm/asset";
import { codeFromScan } from "@/lib/fm/qr";
import { dayOf, isOpen, todayIso } from "@/lib/fm/schedule";
import { assetItems, norm, parseQuery, scoreItem } from "@/lib/fm/search";
import { addPhotos, updateFacility, useFm, verifyAssets } from "@/lib/fm/store";
import { importFile, shareChanges } from "@/lib/fm/sync";
import type { Asset, WorkOrder } from "@/lib/fm/types";
import { FieldRow } from "../assets/AssetDetail";
import { ConditionField } from "../assets/BulkDialogs";
import { WorkOrderDetail } from "../maintenance/WorkOrders";
import { AssetStatusBadge, formatDate, inputCls, Modal, plural, textareaCls, useParam, useSetParams, WorkspaceGate, WoStatusBadge } from "../ui";
import { WorkOrderDialog } from "../WorkOrderDialog";

const RECENT_KEY = "bimos-field-recent";

export function FieldPage() {
  return (
    <WorkspaceGate what="The field app">
      <Field />
    </WorkspaceGate>
  );
}

/** The asset a scanned or typed code stands for: its GlobalId, code, tag, identifier, bar code or serial number. */
function findAsset(assets: Asset[], code: string): Asset | undefined {
  const c = norm(code);
  if (!c) return undefined;
  return assets.find((a) => a.id === code) ?? assets.find((a) => [valueOf(a, "code"), valueOf(a, "tag"), valueOf(a, "assetIdentifier"), valueOf(a, "barCode"), valueOf(a, "serialNumber")].some((v) => v && norm(v) === c));
}

function Field() {
  const assets = useFm((s) => s.assets);
  const [assetParam] = useParam("asset");
  const [scan] = useParam("scan");
  const [tab] = useParam("tab");
  const setParams = useSetParams();
  const asset = useMemo(() => (assetParam ? findAsset(assets, assetParam) : undefined), [assets, assetParam]);

  useEffect(() => {
    if (!asset) return;
    try {
      const list: string[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      localStorage.setItem(RECENT_KEY, JSON.stringify([asset.id, ...list.filter((id) => id !== asset.id)].slice(0, 12)));
    } catch {
      /* storage unavailable */
    }
  }, [asset]);

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-[560px] flex-col gap-3 p-3">
        <OfflineNote />
        {tab === "sync" ? (
          <SyncView onBack={() => setParams({ tab: null })} />
        ) : assetParam && asset ? (
          <FieldAsset asset={asset} onBack={() => setParams({ asset: null })} />
        ) : (
          <>
            {assetParam && !asset ? (
              <Callout tone="warn">
                No asset with the code <b>{assetParam}</b> in this workspace. It may belong to another building, or this device has an older copy of the register.
              </Callout>
            ) : null}
            <FieldHome onScan={() => setParams({ scan: "1" })} onOpen={(id) => setParams({ asset: id, scan: null })} />
          </>
        )}
      </div>
      {scan ? <Scanner onClose={() => setParams({ scan: null })} onCode={(code) => setParams({ asset: codeFromScan(code), scan: null, tab: null })} /> : null}
    </div>
  );
}

function OfflineNote() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (online) return null;
  return (
    <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-[12px] text-fg-2">
      <CloudOff size={14} /> Offline. Everything you do is kept on this phone.
    </div>
  );
}

function FieldHome({ onScan, onOpen }: { onScan: () => void; onOpen: (id: string) => void }) {
  const facility = useFm((s) => s.facility)!;
  const assets = useFm((s) => s.assets);
  const workOrders = useFm((s) => s.workOrders);
  const rev = useFm((s) => s.rev);
  const [text, setText] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => assetItems(assets), [rev]);
  const results = useMemo(() => {
    const { tokens } = parseQuery(text);
    if (!tokens.length) return [];
    return items
      .map((item) => ({ item, score: scoreItem(item, tokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((r) => r.item);
  }, [items, text]);
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    try {
      setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"));
    } catch {
      setRecent([]);
    }
  }, []);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const today = todayIso();
  const checkedToday = assets.filter((a) => dayOf(a.verified?.at) === today).length;
  const mine = workOrders.filter((w) => isOpen(w) && (!w.assignee || w.assignee === facility.user)).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8);
  const changed = assets.filter((a) => (a.edits && Object.keys(a.edits).length) || a.verified || a.photos?.length).length;

  return (
    <>
      <div>
        <h1 className="text-[17px] font-semibold tracking-tight text-fg">{facility.name}</h1>
        <p className="text-[12px] text-fg-3">
          Field app · {facility.user ? `as ${facility.user}` : <NameSetter />}
        </p>
      </div>
      <button type="button" onClick={onScan} className="flex h-16 items-center justify-center gap-3 rounded-xl bg-accent text-[15px] font-semibold text-accent-fg active:opacity-90">
        <ScanLine size={22} /> Scan a label
      </button>
      <label className="flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 focus-within:border-accent">
        <Search size={16} className="shrink-0 text-fg-3" />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Code, name, room…" className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none focus-ring-none placeholder:text-fg-3" aria-label="Find an asset" inputMode="search" />
        {text ? (
          <button type="button" onClick={() => setText("")} aria-label="Clear" className="p-1 text-fg-3">
            <X size={15} />
          </button>
        ) : null}
      </label>
      {text ? (
        <List>
          {results.length === 0 ? <li className="px-3 py-4 text-center text-[13px] text-fg-3">Nothing matches.</li> : null}
          {results.map((r) => (
            <Row key={r.id} title={r.title} subtitle={r.subtitle} onClick={() => onOpen(r.id)} />
          ))}
        </List>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Figure label="Checked today" value={checkedToday} />
            <Figure label="Changed on this phone" value={changed} />
          </div>
          {mine.length ? (
            <section>
              <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-3">Open work {facility.user ? "for you" : ""}</h2>
              <List>
                {mine.map((w) => (
                  <Row key={w.id} title={`${w.number} · ${w.title}`} subtitle={`Due ${formatDate(w.due)}${w.assetIds[0] && byId.get(w.assetIds[0]) ? ` · ${valueOf(byId.get(w.assetIds[0])!, "name")}` : ""}`} onClick={() => w.assetIds[0] && onOpen(w.assetIds[0])} right={<WoStatusBadge status={w.status} />} />
                ))}
              </List>
            </section>
          ) : null}
          {recent.filter((id) => byId.has(id)).length ? (
            <section>
              <h2 className="mb-1 flex items-center gap-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-3">
                <History size={12} /> Recently opened
              </h2>
              <List>
                {recent
                  .map((id) => byId.get(id))
                  .filter((a): a is Asset => Boolean(a))
                  .map((a) => (
                    <Row key={a.id} title={valueOf(a, "name")} subtitle={[valueOf(a, "code"), valueOf(a, "floor"), valueOf(a, "space")].filter(Boolean).join(" · ")} onClick={() => onOpen(a.id)} right={<AssetStatusBadge status={statusOf(a)} />} />
                  ))}
              </List>
            </section>
          ) : null}
          <Link href="/field?tab=sync" className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-3">
            <Share2 size={18} className="text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-fg">Share changes</span>
              <span className="block text-[12px] text-fg-3">Send what you did here to the office, or bring theirs in</span>
            </span>
            <ChevronRight size={16} className="text-fg-3" />
          </Link>
        </>
      )}
    </>
  );
}

function NameSetter() {
  const [name, setName] = useState("");
  return (
    <span className="inline-flex items-center gap-1">
      <input className="h-6 w-32 rounded border border-line-strong bg-surface px-1 text-[12px]" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
      <button type="button" className="text-accent" disabled={!name.trim()} onClick={() => updateFacility({ user: name.trim() })}>
        Save
      </button>
    </span>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2">
      <div className="text-[11.5px] text-fg-3">{label}</div>
      <div className="text-[20px] font-semibold text-fg">{value.toLocaleString()}</div>
    </div>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">{children}</ul>;
}

function Row({ title, subtitle, onClick, right }: { title: string; subtitle: string; onClick: () => void; right?: React.ReactNode }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-center gap-2 px-3 py-2.5 text-left active:bg-surface-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] text-fg">{title}</span>
          <span className="block truncate text-[12px] text-fg-3">{subtitle}</span>
        </span>
        {right}
        <ChevronRight size={15} className="shrink-0 text-fg-3" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// One asset

function FieldAsset({ asset, onBack }: { asset: Asset; onBack: () => void }) {
  const workOrders = useFm((s) => s.workOrders);
  const photos = useFm((s) => s.photos).filter((p) => p.assetId === asset.id);
  const [checking, setChecking] = useState(false);
  const [fault, setFault] = useState(false);
  const [openWo, setOpenWo] = useState<WorkOrder | null>(null);
  const [more, setMore] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const orders = workOrders.filter((w) => w.assetIds.includes(asset.id) && isOpen(w));
  const fields = more ? ["tag", ...KEY_FIELDS.filter((f) => f !== "space"), "barCode", "assetIdentifier", "condition", "comments", "warrantyStartDate", "supplier", "installer", "criticality"] : ["tag", ...KEY_FIELDS.filter((f) => f !== "space")];

  return (
    <>
      <button type="button" onClick={onBack} className="flex items-center gap-1 self-start text-[13px] text-accent">
        <ArrowLeft size={15} /> Back
      </button>
      <section className="rounded-xl border border-line bg-surface p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-[17px] font-semibold leading-tight text-fg">{valueOf(asset, "name")}</h1>
            <div className="mt-0.5 font-mono text-[12.5px] text-fg-2">{valueOf(asset, "code")}</div>
          </div>
          <AssetStatusBadge status={statusOf(asset)} />
        </div>
        <div className="mt-2 text-[13px] text-fg">{asset.kind}</div>
        <div className="text-[12.5px] text-fg-2">{[valueOf(asset, "floor"), valueOf(asset, "space"), asset.roomName].filter(Boolean).join(" · ") || "Location not known"}</div>
        {asset.fedFrom ? <div className="mt-1 text-[12px] text-fg-3">Fed from {asset.fedFrom}</div> : null}
      </section>

      <div className="grid grid-cols-3 gap-2">
        <BigAction icon={CheckCircle2} label={dayOf(asset.verified?.at) === todayIso() ? "Checked" : "Check"} tone={asset.verified ? "ok" : undefined} onClick={() => setChecking(true)} />
        <BigAction icon={Camera} label={photos.length ? `Photo (${photos.length})` : "Photo"} onClick={() => photoInput.current?.click()} />
        <BigAction icon={AlertTriangle} label="Fault" tone="bad" onClick={() => setFault(true)} />
      </div>
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void addPhotos(asset.id, files).then(() => pushToast("success", "Photo saved on this phone."));
        }}
      />

      {asset.verified ? (
        <p className="px-1 text-[12px] text-fg-3">
          Last checked {formatDate(dayOf(asset.verified.at))} by {asset.verified.by}
          {asset.verified.condition ? `, condition ${asset.verified.condition} of 5` : ""}.
        </p>
      ) : null}

      {orders.length ? (
        <section>
          <h2 className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-3">Open work</h2>
          <List>
            {orders.map((w) => (
              <Row key={w.id} title={`${w.number} · ${w.title}`} subtitle={`Due ${formatDate(w.due)}${w.assignee ? ` · ${w.assignee}` : ""}`} onClick={() => setOpenWo(w)} right={<WoStatusBadge status={w.status} />} />
            ))}
          </List>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <h2 className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-fg-3">Information (tap to change)</h2>
        <div className="divide-y divide-line">
          {fields.map((f) => (
            <FieldRow key={f} asset={asset} field={f} />
          ))}
        </div>
        <button type="button" onClick={() => setMore((v) => !v)} className="w-full border-t border-line px-3 py-2 text-left text-[12.5px] text-accent">
          {more ? "Fewer fields" : "More fields"}
        </button>
      </section>
      <Link href={`/assets?asset=${encodeURIComponent(asset.id)}`} className="px-1 text-[12.5px] text-accent">
        All details, maintenance and history
      </Link>

      {checking ? <CheckDialog asset={asset} onClose={() => setChecking(false)} /> : null}
      <WorkOrderDialog open={fault} onClose={() => setFault(false)} assetIds={[asset.id]} defaults={{ kind: "reactive", priority: "high" }} />
      {openWo ? (
        <Modal open onClose={() => setOpenWo(null)} title={`${openWo.number} · ${openWo.title}`}>
          <WorkOrderDetail wo={workOrders.find((w) => w.id === openWo.id) ?? openWo} compactView />
        </Modal>
      ) : null}
    </>
  );
}

function BigAction({ icon: Icon, label, tone, onClick }: { icon: typeof Camera; label: string; tone?: "ok" | "bad"; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={clsx("flex h-[68px] flex-col items-center justify-center gap-1 rounded-xl border bg-surface text-[12.5px] font-medium active:bg-surface-2", tone === "ok" ? "border-ok/40 text-ok" : tone === "bad" ? "border-bad/30 text-bad" : "border-line text-fg")}>
      <Icon size={20} />
      {label}
    </button>
  );
}

function CheckDialog({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [condition, setCondition] = useState(asset.verified?.condition ? String(asset.verified.condition) : "");
  const [notes, setNotes] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title="Checked on site"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              verifyAssets([asset.id], { condition: condition ? Number(condition) : undefined, notes: notes.trim() || undefined });
              pushToast("success", "Recorded as checked.");
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-fg-2">The asset was found here and its label and information are right (change what is not first).</p>
        <ConditionField value={condition} onChange={setCondition} />
        <label className="flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-2">Notes</span>
          <textarea className={textareaCls} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </label>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Scanner

interface Detector {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}

function Scanner({ onClose, onCode }: { onClose: () => void; onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [typed, setTyped] = useState("");
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    const onCode = (code: string) => onCodeRef.current(code);
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!Ctor) {
      setSupported(false);
      return;
    }
    const detector = new Ctor({ formats: ["qr_code", "data_matrix", "code_128", "code_39", "ean_13"] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const look = async () => {
          if (stopped || !video.current) return;
          try {
            const found = await detector.detect(video.current);
            if (found[0]?.rawValue) {
              stopped = true;
              if (navigator.vibrate) navigator.vibrate(60);
              onCode(found[0].rawValue);
              return;
            }
          } catch {
            /* a frame that could not be read */
          }
          timer = setTimeout(look, 200);
        };
        void look();
      } catch (e) {
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? "The camera was not allowed. Allow it in the browser's site settings, or type the code below." : "The camera could not be started. Type the code below.");
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[14px] font-medium">Scan an asset label</span>
        <button type="button" onClick={onClose} aria-label="Close the scanner" className="grid size-9 place-items-center rounded-full bg-white/10">
          <X size={18} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {supported && !error ? (
          <>
            <video ref={video} className="h-full w-full object-cover" playsInline muted />
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="size-[62vmin] rounded-2xl border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.35)]" />
            </div>
          </>
        ) : (
          <div className="grid h-full place-items-center p-6 text-center text-[13.5px] leading-relaxed text-white/85">
            {error ?? "This browser cannot read codes from the camera. Point the phone's own camera app at the label (labels printed with the app's address open the asset), or type the code below."}
          </div>
        )}
      </div>
      <form
        className="flex gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) onCode(typed.trim());
        }}
      >
        <input className={clsx(inputCls, "h-11 bg-white text-[15px] text-black")} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type the code" aria-label="Asset code" autoCapitalize="characters" />
        <Button variant="primary" className="h-11 px-4" type="submit">
          Open
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sharing changes

function SyncView({ onBack }: { onBack: () => void }) {
  const facility = useFm((s) => s.facility)!;
  const assets = useFm((s) => s.assets);
  const workOrders = useFm((s) => s.workOrders);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<{ facility: string; assets: number; current: string | null; apply: () => Promise<void> } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const changed = assets.filter((a) => (a.edits && Object.keys(a.edits).length) || a.verified || a.photos?.length).length;

  return (
    <>
      <button type="button" onClick={onBack} className="flex items-center gap-1 self-start text-[13px] text-accent">
        <ArrowLeft size={15} /> Back
      </button>
      <h1 className="text-[17px] font-semibold tracking-tight text-fg">Share changes</h1>
      <p className="text-[12.5px] leading-relaxed text-fg-2">
        Everything done on this device stays here until it is shared. The change file goes to the office (mail, messaging, a shared drive) and is brought into the main workspace there, under Settings, or on another device here.
      </p>
      <section className="rounded-xl border border-line bg-surface p-3">
        <div className="text-[13px] text-fg">
          {plural(changed, "asset")} changed or checked · {plural(workOrders.length, "work order")}
        </div>
        <label className="mt-2 flex flex-col gap-1">
          <span className="text-[11.5px] font-medium text-fg-2">Your name, recorded with your changes</span>
          <input className={inputCls} defaultValue={facility.user} onBlur={(e) => e.target.value.trim() !== facility.user && updateFacility({ user: e.target.value.trim() })} placeholder="Your name" />
        </label>
        <Button
          variant="primary"
          className="mt-3 h-10 w-full"
          icon={<Share2 size={16} />}
          busy={busy === "share"}
          onClick={async () => {
            setBusy("share");
            try {
              const r = await shareChanges();
              if (r) setMessage(`Change file ${r.shared ? "shared" : "saved"}: ${plural(r.assets, "asset")}, ${plural(r.workOrders, "work order")}, ${plural(r.photos, "photo")}.`);
            } finally {
              setBusy(null);
            }
          }}
        >
          Share the changes
        </Button>
      </section>
      <section className="rounded-xl border border-line bg-surface p-3">
        <div className="text-[13px] font-medium text-fg">Bring in a file</div>
        <p className="mt-0.5 text-[12px] text-fg-3">A change file from someone else, or a workspace file to set this device up with the latest register.</p>
        <Button className="mt-2 h-10 w-full" icon={<Upload size={16} />} busy={busy === "import"} onClick={() => input.current?.click()}>
          Choose a file
        </Button>
        <input
          ref={input}
          type="file"
          accept=".bimos,.zip,application/zip"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy("import");
            try {
              const r = await importFile(file);
              if (r.kind === "changes") setMessage(r.text);
              else setPending(r);
            } catch (error) {
              setMessage(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(null);
            }
          }}
        />
      </section>
      {message ? <Callout tone="info">{message}</Callout> : null}
      {pending ? (
        <Modal
          open
          onClose={() => setPending(null)}
          title="Replace the workspace on this device?"
          footer={
            <>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button
                variant="danger"
                icon={<RefreshCw size={14} />}
                onClick={async () => {
                  await pending.apply();
                  setPending(null);
                  setMessage(`This device now has "${pending.facility}".`);
                }}
              >
                Replace
              </Button>
            </>
          }
        >
          <p className="text-[12.5px] leading-relaxed text-fg-2">
            The file holds <b>{pending.facility}</b> with {plural(pending.assets, "asset")}.{" "}
            {pending.current ? (
              <>
                It replaces <b>{pending.current}</b> on this device; share this device&apos;s changes first if they have not reached the office yet.
              </>
            ) : null}
          </p>
        </Modal>
      ) : null}
      <p className="flex items-center gap-1.5 px-1 text-[12px] text-fg-3">
        <Wrench size={12} /> Work orders made here get the next free number when they are brought in elsewhere.
      </p>
    </>
  );
}
