"use client";

import { Boxes, Cloud, FolderOpen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { ApsSetupNote } from "@/components/ui/ApsSetupNote";
import { Section } from "@/components/ui/Section";
import { Toasts } from "@/components/ui/Toasts";
import { Button, Callout, IconButton } from "@/components/ui/primitives";
import { ApsCancelled, deleteFromAps, getApsStatus, progressFraction, startTranslation, uploadToAps, waitForTranslation } from "@/lib/aps/client";
import { LmvSession, type LmvSource } from "@/lib/lmv/session";
import { forgetModel, loadRecent, rememberModel, useNwdStore, type RecentModel } from "@/lib/nwd/store";
import { pushToast } from "@/lib/store";
import { formatBytes, formatCount } from "@/lib/utils/format";
import { isDarkTheme } from "@/lib/utils/palette";
import { DropHint } from "../viewer/Overlays";
import { ResizablePanel } from "../viewer/Sidebar";
import { BusyLine, ExportSection, GroupsSection, SelectionSection } from "./NwdPanels";

const SAMPLE_URL = "/samples/lmv-shaver/0.svf";
const ACCEPT = ".nwd,.nwc";

function timeLeft(model: RecentModel) {
  const hours = Math.max(0, 24 - (Date.now() - model.at) / 3_600_000);
  return hours >= 1 ? `${Math.floor(hours)} h left` : `${Math.max(1, Math.round(hours * 60))} min left`;
}

/** The Navisworks viewer: Autodesk translates the file in the cloud and its viewer shows it here. */
export function NwdViewer() {
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<LmvSession | null>(null);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const [session, setSession] = useState<LmvSession | null>(null);
  const [width, setWidth] = useState(330);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const aps = useNwdStore((state) => state.aps);
  const phase = useNwdStore((state) => state.phase);
  const step = useNwdStore((state) => state.step);
  const progress = useNwdStore((state) => state.progress);
  const error = useNwdStore((state) => state.error);
  const modelName = useNwdStore((state) => state.modelName);
  const urn = useNwdStore((state) => state.urn);
  const summary = useNwdStore((state) => state.summary);
  const recent = useNwdStore((state) => state.recent);
  const hiddenObjects = useNwdStore((state) => state.hiddenObjects);
  const materialProperties = useNwdStore((state) => state.materialProperties);

  const busy = phase === "uploading" || phase === "translating" || phase === "loading";
  const cloudReady = aps?.configured === true;

  const closeSession = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    setSession(null);
  }, []);

  // Start-up and tear-down.
  useEffect(() => {
    useNwdStore.setState({ recent: loadRecent(), phase: "idle", step: null, progress: undefined, error: null, modelName: null, urn: null, summary: null, selection: [] });
    void getApsStatus().then((status) => useNwdStore.setState({ aps: status }));
    return () => {
      generation.current += 1;
      abort.current?.abort();
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  // Keep the Autodesk viewer's theme and size in step with the app.
  useEffect(() => {
    if (!session) return;
    session.setTheme(isDarkTheme());
    const themeObserver = new MutationObserver(() => session.setTheme(isDarkTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const node = container.current;
    const sizeObserver = new ResizeObserver(() => session.resize());
    if (node) sizeObserver.observe(node);
    return () => {
      themeObserver.disconnect();
      sizeObserver.disconnect();
    };
  }, [session]);

  const openSource = useCallback(
    async (source: LmvSource, name: string, modelUrn: string | null) => {
      const node = container.current;
      if (!node) return;
      const run = ++generation.current;
      closeSession();
      useNwdStore.setState({ phase: "loading", step: "Loading the Autodesk viewer", progress: undefined, error: null, modelName: name, urn: modelUrn, summary: null, selection: [] });
      try {
        const next = await LmvSession.create(node, source, (label, fraction) => run === generation.current && useNwdStore.setState({ step: label, progress: fraction }));
        if (run !== generation.current) {
          next.dispose();
          return;
        }
        next.setTheme(isDarkTheme());
        next.setPickLevel(useNwdStore.getState().pickLevel);
        next.onSelectionChanged((ids) => useNwdStore.setState({ selection: next.unitsOf(ids) }));
        sessionRef.current = next;
        setSession(next);
        useNwdStore.setState({ phase: "ready", step: null, progress: undefined, summary: next.summary() });
      } catch (reason) {
        if (run !== generation.current) return;
        console.warn("Failed to open the model", reason);
        useNwdStore.setState({ phase: "error", step: null, progress: undefined, error: reason instanceof Error ? reason.message : String(reason) });
      }
    },
    [closeSession],
  );

  const openFile = useCallback(
    async (file: File) => {
      if (!/\.(nwd|nwc)$/i.test(file.name)) {
        pushToast("error", `${file.name}: the NWD viewer opens .nwd and .nwc files.`);
        return;
      }
      const status = useNwdStore.getState().aps;
      if (!status?.configured) {
        pushToast("error", "Navisworks files are translated by Autodesk Platform Services, which is not set up yet. See the panel on the left.");
        return;
      }
      const run = ++generation.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      closeSession();
      const set = (patch: Partial<ReturnType<typeof useNwdStore.getState>>) => run === generation.current && useNwdStore.setState(patch);
      set({ phase: "uploading", step: "Uploading to Autodesk", progress: 0, error: null, modelName: file.name, urn: null, summary: null, selection: [] });
      try {
        const modelUrn = await uploadToAps(file, file.name, (fraction) => set({ step: `Uploading to Autodesk · ${formatBytes(Math.round(fraction * file.size))} of ${formatBytes(file.size)}`, progress: fraction }), controller.signal);
        rememberModel({ name: file.name, urn: modelUrn, region: status.region, bytes: file.size, at: Date.now() });
        set({ phase: "translating", step: "Starting the translation", progress: undefined, urn: modelUrn });
        const { hiddenObjects: hidden, materialProperties: materials } = useNwdStore.getState();
        await startTranslation(modelUrn, { output: "svf2", hiddenObjects: hidden, materialProperties: materials }, controller.signal);
        await waitForTranslation(modelUrn, "svf2", (current) => set({ step: `Autodesk is translating the model · ${current.progress || current.status}`, progress: progressFraction(current.progress) }), controller.signal);
        if (run !== generation.current) return;
        await openSource({ kind: "aps", urn: modelUrn, region: status.region }, file.name, modelUrn);
      } catch (reason) {
        if (run !== generation.current) return;
        if (reason instanceof ApsCancelled) set({ phase: "idle", step: null, progress: undefined, modelName: null });
        else {
          console.warn("Failed to open the Navisworks file", reason);
          set({ phase: "error", step: null, progress: undefined, error: reason instanceof Error ? reason.message : String(reason) });
        }
      }
    },
    [closeSession, openSource],
  );

  const openRecent = useCallback(
    async (model: RecentModel) => {
      const run = ++generation.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      closeSession();
      useNwdStore.setState({ phase: "translating", step: "Checking the cloud copy", progress: undefined, error: null, modelName: model.name, urn: model.urn, summary: null, selection: [] });
      try {
        // Resumes a translation that was still running, or returns at once when it is done.
        await waitForTranslation(model.urn, "svf2", (current) => run === generation.current && useNwdStore.setState({ step: `Autodesk is translating the model · ${current.progress || current.status}`, progress: progressFraction(current.progress) }), controller.signal, 20 * 60 * 1000);
        if (run !== generation.current) return;
        await openSource({ kind: "aps", urn: model.urn, region: model.region }, model.name, model.urn);
      } catch (reason) {
        if (run !== generation.current) return;
        if (reason instanceof ApsCancelled) useNwdStore.setState({ phase: "idle", step: null, progress: undefined, modelName: null });
        else useNwdStore.setState({ phase: "error", step: null, progress: undefined, error: `${reason instanceof Error ? reason.message : String(reason)} The cloud copy may have expired; open the file again.` });
      }
    },
    [closeSession, openSource],
  );

  const removeRecent = async (model: RecentModel) => {
    if (urn === model.urn) {
      generation.current += 1;
      closeSession();
      useNwdStore.setState({ phase: "idle", step: null, modelName: null, urn: null, summary: null, selection: [] });
    }
    forgetModel(model.urn);
    const deleted = await deleteFromAps(model.urn);
    pushToast(deleted ? "success" : "info", deleted ? `${model.name} was deleted from Autodesk's cloud.` : `${model.name} was removed from this list. The cloud copy could not be deleted now; Autodesk removes it 24 hours after the upload.`);
  };

  const cancel = () => {
    generation.current += 1;
    abort.current?.abort();
    closeSession();
    useNwdStore.setState({ phase: "idle", step: null, progress: undefined, modelName: null, urn: null });
  };

  // --- Drag and drop ---------------------------------------------------------
  const onDragEnter = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void openFile(file);
  };

  return (
    <div className="flex h-full min-h-0">
      <ResizablePanel side="left" width={width} onWidth={setWidth} title="Navisworks model" min={280} max={560}>
        <div className="scroll-thin h-full overflow-y-auto">
          <Section title="Open">
            <div className="px-3">
              <p className="text-[12px] leading-relaxed text-fg-2">
                Navisworks files can only be read by Autodesk software. The file is uploaded to your Autodesk Platform Services account, translated there, and shown here in Autodesk&apos;s
                viewer. Select objects or groups and export them as IFC.
              </p>
              {aps !== null && !cloudReady ? <ApsSetupNote onRetry={() => void getApsStatus().then((status) => useNwdStore.setState({ aps: status }))} /> : null}

              {cloudReady ? (
                <div className="mt-2.5 flex flex-col gap-1.5">
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="checkbox" checked={materialProperties} onChange={(event) => useNwdStore.setState({ materialProperties: event.target.checked })} className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]" />
                    <span className="text-[12px] text-fg">Include material properties</span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="checkbox" checked={hiddenObjects} onChange={(event) => useNwdStore.setState({ hiddenObjects: event.target.checked })} className="mt-[3px] size-3.5 shrink-0 accent-[var(--accent)]" />
                    <span className="text-[12px] text-fg">Include objects hidden in Navisworks</span>
                  </label>
                </div>
              ) : null}

              <input
                ref={input}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void openFile(file);
                }}
              />
              <div className="mt-3 flex flex-col gap-1.5">
                <Button variant="primary" className="w-full" icon={<FolderOpen size={14} />} disabled={!cloudReady || busy} onClick={() => input.current?.click()}>
                  Open Navisworks file
                </Button>
                <Button className="w-full" icon={<Boxes size={14} />} disabled={busy} onClick={() => void openSource({ kind: "url", url: SAMPLE_URL }, "Sample assembly", null)} title="A small mechanical sample bundled with the app, to try selection and IFC export without an Autodesk account">
                  Open the built-in sample
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-fg-3">.nwd, .nwc · uploads are deleted by Autodesk after 24 hours{aps?.region ? ` · region ${aps.region}` : ""}. The sample is not a building model; it only demonstrates the tools.</p>

              {busy && step ? (
                <div className="mt-3">
                  <BusyLine label={step} progress={progress} onCancel={cancel} />
                </div>
              ) : null}
              {phase === "error" && error ? (
                <Callout tone="bad" className="mt-3">
                  <div className="break-words">{error}</div>
                </Callout>
              ) : null}
            </div>
          </Section>

          {recent.length > 0 ? (
            <Section title="In your Autodesk cloud" count={recent.length} defaultOpen={!session}>
              <ul className="flex flex-col">
                {recent.map((model) => (
                  <li key={model.urn} className="flex items-center gap-1 px-3 py-1">
                    <button
                      type="button"
                      disabled={busy || !cloudReady}
                      onClick={() => void openRecent(model)}
                      className="min-w-0 flex-1 rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
                      title="Open without uploading again"
                    >
                      <span className="flex items-center gap-1.5 text-[12px] text-fg">
                        <Cloud size={12} className="shrink-0 text-fg-3" />
                        <span className="min-w-0 truncate">{model.name}</span>
                      </span>
                      <span className="block pl-[18px] text-[11px] text-fg-3">
                        {formatBytes(model.bytes)} · {timeLeft(model)}
                      </span>
                    </button>
                    <IconButton label="Delete from Autodesk's cloud" size="sm" onClick={() => void removeRecent(model)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {session && summary ? (
            <>
              <Section title="Model">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 text-[12px]">
                  <dt className="text-fg-3">Name</dt>
                  <dd className="break-words text-fg">{modelName}</dd>
                  <dt className="text-fg-3">Objects</dt>
                  <dd className="tabular text-fg">{formatCount(summary.elements)}</dd>
                  <dt className="text-fg-3">Triangles</dt>
                  <dd className="tabular text-fg">{formatCount(summary.triangles)}</dd>
                  <dt className="text-fg-3">Units</dt>
                  <dd className="text-fg">
                    {summary.unit === "unitless" ? "Not stated (treated as metres)" : summary.unit} · {summary.upAxis} up
                  </dd>
                </dl>
              </Section>
              <SelectionSection session={session} />
              <GroupsSection session={session} />
              <ExportSection session={session} />
            </>
          ) : null}
        </div>
      </ResizablePanel>

      <section className="viewport-bg relative min-w-0 flex-1 overflow-hidden" aria-label="3D view" onDragEnter={onDragEnter} onDragOver={(event) => event.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
        <div ref={container} className="absolute inset-0" data-testid="lmv-container" />
        {!session && !busy ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
            <div className="max-w-sm text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-xl border border-line bg-surface text-fg-3">
                <Boxes size={22} strokeWidth={1.5} />
              </div>
              <h1 className="mt-3 text-[15px] font-semibold text-fg">Open a Navisworks model</h1>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">
                Drop an .nwd or .nwc file here, or use the panel on the left. Autodesk translates the file in the cloud; this page then lets you select objects or groups and export them as
                IFC.
              </p>
            </div>
          </div>
        ) : null}
        <Toasts />
        <DropHint visible={dragging} label="Drop a Navisworks file to open it" />
      </section>
    </div>
  );
}
