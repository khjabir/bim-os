"use client";

// Turning the on-device assistant on and off, choosing its model, and the
// model's copy in this browser (download, remove). The full panel sits in
// Settings; the plan editor shows the compact one.

import { Bot, Download, HardDrive, Square, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { Button, Callout, ProgressBar, Select, Spinner } from "@/components/ui/primitives";
import { canRun, checkSupport, loadAssistant, loadAssistantPrefs, refreshDownloaded, removeDownloaded, setAssistantEnabled, setAssistantModel, sizeText, stopAnswer, unloadAssistant, useAssistant } from "@/lib/ondevice/engine";
import { ASSISTANT_MODELS, assistantModel } from "@/lib/ondevice/models";

/** Checks the browser and which models are downloaded, in Settings or when the assistant is on (the download check starts the model's worker). */
function useAssistantChecks(always: boolean) {
  useEffect(() => {
    loadAssistantPrefs();
    // Asking for a graphics adapter logs a warning in browsers without one: only when it matters.
    if (always || useAssistant.getState().enabled) {
      void checkSupport();
      void refreshDownloaded();
    }
  }, [always]);
}

export function OnDeviceStatus({ compact = false }: { compact?: boolean }) {
  const s = useAssistant();
  const model = assistantModel(s.modelId);
  if (s.status === "loading")
    return (
      <div className="flex flex-col gap-1" data-testid="assistant-loading">
        <p className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
          <Spinner size={12} /> {s.detail ?? "Starting the model"}…
        </p>
        <ProgressBar value={s.progress === null ? undefined : s.progress} />
      </div>
    );
  if (s.status === "busy")
    return (
      <p className="flex items-center gap-1.5 text-[11.5px] text-fg-2" data-testid="assistant-busy">
        <Spinner size={12} /> {s.detail ?? "Thinking"}…
        <button type="button" className="ml-auto inline-flex items-center gap-1 text-[11px] text-fg-3 underline" onClick={stopAnswer}>
          <Square size={10} /> Stop
        </button>
      </p>
    );
  if (s.status === "error" && s.error) return <Callout tone="warn">{s.error}</Callout>;
  if (!s.enabled) return null;
  const downloaded = model.engine === "webllm" ? s.downloaded[model.id] : undefined;
  return (
    <p className="text-[11.5px] leading-snug text-fg-3" data-testid="assistant-state">
      {s.loaded === model.id ? `${model.label} is ready${s.lastSeconds ? ` · last answer in ${s.lastSeconds < 10 ? s.lastSeconds.toFixed(1) : Math.round(s.lastSeconds)} s` : ""}.` : model.engine === "chrome" ? `${model.label}: starts when first asked.` : downloaded ? `${model.label} is in this browser: it starts when first asked.` : `${model.label} downloads when first asked (${sizeText(model.sizeMB)}, once).`}
      {compact ? null : ""}
    </p>
  );
}

/** Model choice with what each one needs. */
function ModelSelect() {
  const s = useAssistant();
  return (
    <Select aria-label="Assistant model" value={s.modelId} onChange={(e) => setAssistantModel(e.target.value)} disabled={s.status === "loading" || s.status === "busy"}>
      {ASSISTANT_MODELS.map((m) => (
        <option key={m.id} value={m.id} disabled={!canRun(m, s.support) && s.support !== null}>
          {m.label}
          {m.sizeMB ? ` · ${sizeText(m.sizeMB)}` : ""}
          {s.downloaded[m.id] ? " · downloaded" : ""}
          {!canRun(m, s.support) && s.support !== null ? " · not available here" : ""}
        </option>
      ))}
    </Select>
  );
}

function SupportNote() {
  const s = useAssistant();
  const model = assistantModel(s.modelId);
  if (!s.support) return null;
  if (model.engine === "webllm" && !s.support.webgpu) return <Callout tone="warn">{s.support.reason} The assistant&apos;s open models need WebGPU.</Callout>;
  if (model.engine === "chrome" && !canRun(model, s.support)) return <Callout tone="warn">This browser has no built-in model the assistant can use (Chrome 148 or later on a computer that meets its needs).</Callout>;
  return null;
}

/** The compact controls of the plan editor: on/off, the model, and its state. */
export function OnDeviceSwitch() {
  useAssistantChecks(false);
  const s = useAssistant();
  const model = assistantModel(s.modelId);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line p-2" data-testid="assistant-switch">
      <div className="flex items-center gap-2">
        <Bot size={14} className="shrink-0 text-fg-3" aria-hidden />
        <span className="min-w-0 flex-1 text-[12px] text-fg">On-device assistant</span>
        <Button
          size="sm"
          variant={s.enabled ? "secondary" : "primary"}
          onClick={() => {
            if (s.enabled) return setAssistantEnabled(false);
            setAssistantEnabled(true);
            // Chrome's model starts its download only from a click.
            if (model.engine === "chrome") void loadAssistant().catch(() => undefined);
          }}
          data-testid="assistant-toggle"
        >
          {s.enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
      {s.enabled ? <ModelSelect /> : <p className="text-[11px] leading-snug text-fg-3">Suggests room types, reads the drawing&apos;s notes and makes changes you ask for in words. It runs in this browser with a free, openly licensed model: nothing is sent anywhere.</p>}
      <SupportNote />
      <OnDeviceStatus compact />
    </div>
  );
}

/** Settings: everything about the assistant. */
export function OnDeviceSettings() {
  useAssistantChecks(true);
  const s = useAssistant();
  const model = assistantModel(s.modelId);
  const busy = s.status === "loading" || s.status === "busy";
  return (
    <div className="flex flex-col gap-3" data-testid="assistant-settings">
      <p className="max-w-[90ch] text-[12.5px] leading-relaxed text-fg-2">
        The assistant suggests room types from room names in any language, reads the notes on drawings (heights, levels, thicknesses, names) and turns changes you type in plain words into edits of a floor plan. It runs entirely in this browser: the model is downloaded once and kept here, and drawings and requests never leave this device. It is off until you turn it on, and everything it suggests is shown for you to accept.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={s.enabled ? "secondary" : "primary"} icon={<Bot size={13} />} onClick={() => setAssistantEnabled(!s.enabled)}>
          {s.enabled ? "Turn the assistant off" : "Turn the assistant on"}
        </Button>
        <div className="w-[300px] max-w-full">
          <ModelSelect />
        </div>
        {s.enabled && s.loaded !== model.id ? (
          <Button icon={busy ? <Spinner size={12} /> : <Download size={13} />} disabled={busy || !canRun(model, s.support)} onClick={() => void loadAssistant().catch(() => undefined)}>
            {model.engine === "webllm" && !s.downloaded[model.id] ? `Download now (${sizeText(model.sizeMB)})` : "Start it now"}
          </Button>
        ) : null}
        {s.loaded ? (
          <Button onClick={() => void unloadAssistant()} disabled={busy}>
            Free its memory
          </Button>
        ) : null}
      </div>
      <p className="text-[11.5px] leading-snug text-fg-3">{model.note}</p>
      <SupportNote />
      <OnDeviceStatus />
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {ASSISTANT_MODELS.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-[12px]">
            <HardDrive size={13} className="shrink-0 text-fg-3" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-fg">{m.label}</span>
              <span className="text-fg-3">
                {" "}
                · {m.maker} ·{" "}
                <a className="underline" href={m.licenceUrl} target="_blank" rel="noreferrer">
                  {m.licence}
                </a>
                {m.sizeMB ? ` · ${sizeText(m.sizeMB)}` : ""}
              </span>
            </span>
            {m.engine === "webllm" ? (
              s.downloaded[m.id] ? (
                <Button size="sm" variant="danger" icon={<Trash2 size={12} />} disabled={busy} onClick={() => void removeDownloaded(m.id)}>
                  Remove from this browser
                </Button>
              ) : (
                <span className="text-[11px] text-fg-3">Not downloaded</span>
              )
            ) : (
              <span className="text-[11px] text-fg-3">{s.support?.chrome ? (s.support.chrome === "unavailable" ? "Not in this browser" : s.support.chrome === "available" ? "In this browser" : "Chrome can download it") : "Not in this browser"}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[11px] leading-snug text-fg-3">
        Open models run with WebLLM on WebGPU and come from Hugging Face (huggingface.co, mlc-ai builds). Chrome&apos;s built-in model is Google&apos;s and is downloaded and updated by Chrome itself. {s.support ? `This browser: WebGPU ${s.support.webgpu ? (s.support.f16 ? "yes (16-bit)" : "yes") : "no"}.` : ""}
      </p>
    </div>
  );
}
