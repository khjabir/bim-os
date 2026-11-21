// Chat state for the Assistant panel. It lives outside the component so the
// conversation (and a question in flight) survives switching side-panel tabs.

import { create } from "zustand";
import type { ViewerEngine } from "@/lib/engine/engine";
import { uid, useViewerStore, type PlainIdMap } from "@/lib/store";
import { ask, AssistantRequestError, Conversation, isAbort, type TurnEvent } from "./client";
import { createRuntime, type AssistantRuntime } from "./tools";

export type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "tool"; callId: string; name: string; summary: string; status: "running" | "done" | "error"; items?: PlainIdMap }
  | { id: string; kind: "notice"; tone: "info" | "warn" | "bad"; text: string; retry?: string };

interface AssistantState {
  items: ChatItem[];
  busy: boolean;
  /** null until the server has been asked whether a key is configured. */
  configured: boolean | null;
  model: string | null;
  usage: { input: number; output: number };
}

const INITIAL: AssistantState = { items: [], busy: false, configured: null, model: null, usage: { input: 0, output: 0 } };

export const useAssistantStore = create<AssistantState>(() => ({ ...INITIAL }));

let boundEngine: ViewerEngine | null = null;
let runtime: AssistantRuntime | null = null;
let conversation = new Conversation();
let controller: AbortController | null = null;

const TOOL_LABEL: Record<string, string> = {
  get_model_overview: "Reading the model overview",
  find_elements: "Searching elements",
  get_element_details: "Reading an element",
  get_property_values: "Reading property values",
  get_quantities: "Taking off quantities",
  group_elements: "Grouping elements",
  run_health_checks: "Running health checks",
  get_selection: "Reading the selection",
  show_in_viewer: "Updating the 3D view",
  reset_viewer: "Resetting the 3D view",
};

function push(item: ChatItem) {
  useAssistantStore.setState((state) => ({ items: [...state.items, item] }));
}

function apply(event: TurnEvent) {
  switch (event.type) {
    case "text":
      push({ id: uid(), kind: "assistant", text: event.text });
      break;
    case "tool-start":
      push({ id: uid(), kind: "tool", callId: event.id, name: event.name, summary: TOOL_LABEL[event.name] ?? event.name, status: "running" });
      break;
    case "tool-end":
      useAssistantStore.setState((state) => ({
        items: state.items.map((item) =>
          item.kind === "tool" && item.callId === event.id ? { ...item, summary: event.summary, status: event.isError ? "error" : "done", items: event.items } : item,
        ),
      }));
      break;
    case "notice":
      push({ id: uid(), kind: "notice", tone: event.tone, text: event.text });
      break;
    case "usage":
      useAssistantStore.setState((state) => ({ usage: { input: state.usage.input + event.input, output: state.usage.output + event.output } }));
      break;
  }
}

function describeViewer(): string {
  const { models, selectionCount } = useViewerStore.getState();
  if (models.length === 0) return "No model is loaded.";
  const list = models.map((model) => `"${model.name}" (model id ${model.id}, ${model.elementCount} elements with geometry${model.schema ? `, ${model.schema}` : ""}${model.note ? `, ${model.note}` : ""}${model.visible ? "" : ", hidden"})`).join("; ");
  return `Loaded models: ${list}. Selection: ${selectionCount === 0 ? "nothing selected" : `${selectionCount} element${selectionCount === 1 ? "" : "s"} selected (use get_selection)`}.`;
}

/** Asks the server whether an API key is configured. Never returns the key. */
export async function refreshAssistantStatus(): Promise<void> {
  try {
    const response = await fetch("/api/assistant", { cache: "no-store" });
    const payload = (await response.json()) as { configured?: boolean; model?: string };
    useAssistantStore.setState({ configured: Boolean(payload.configured), model: payload.model ?? null });
  } catch {
    useAssistantStore.setState({ configured: false, model: null });
  }
}

/** Starts over with an empty conversation. Also called when the viewer is replaced. */
export function resetAssistant(engine: ViewerEngine | null = boundEngine) {
  controller?.abort();
  controller = null;
  conversation = new Conversation();
  boundEngine = engine;
  runtime = engine ? createRuntime(engine) : null;
  useAssistantStore.setState((state) => ({ ...INITIAL, configured: state.configured, model: state.model }));
}

export function stopAssistant() {
  controller?.abort();
}

export async function askAssistant(engine: ViewerEngine, question: string): Promise<void> {
  const trimmed = question.trim();
  if (!trimmed || useAssistantStore.getState().busy) return;
  if (engine !== boundEngine || !runtime) resetAssistant(engine);
  const activeRuntime = runtime;
  if (!activeRuntime) return;

  const abort = new AbortController();
  controller = abort;
  push({ id: uid(), kind: "user", text: trimmed });
  useAssistantStore.setState({ busy: true });
  const session = conversation;

  try {
    await ask({ conversation: session, runtime: activeRuntime, question: trimmed, viewerState: describeViewer(), signal: abort.signal, onEvent: (event) => session === conversation && apply(event) });
  } catch (error) {
    // A reset while this question was in flight already cleared the chat.
    if (session !== conversation) return;
    if (isAbort(error)) {
      useAssistantStore.setState((state) => ({ items: state.items.map((item) => (item.kind === "tool" && item.status === "running" ? { ...item, status: "error", summary: `${item.summary} (stopped)` } : item)) }));
      push({ id: uid(), kind: "notice", tone: "info", text: "Stopped." });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AssistantRequestError && error.status === 503) useAssistantStore.setState({ configured: false });
      console.warn("[assistant]", error);
      push({ id: uid(), kind: "notice", tone: "bad", text: message || "The request failed.", retry: trimmed });
    }
  } finally {
    if (controller === abort) controller = null;
    if (session === conversation) useAssistantStore.setState({ busy: false });
  }
}
