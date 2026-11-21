"use client";

import clsx from "clsx";
import { ArrowUp, Check, ChevronRight, CircleAlert, MousePointerClick, RotateCcw, Sparkles, Square, SquarePen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Markdown } from "@/components/ui/Markdown";
import { Button, Callout, IconButton, Spinner } from "@/components/ui/primitives";
import { askAssistant, refreshAssistantStatus, resetAssistant, stopAssistant, useAssistantStore, type ChatItem } from "@/lib/assistant/session";
import { useEngine } from "@/lib/engine/context";
import type { ViewerEngine } from "@/lib/engine/engine";
import { useViewerStore } from "@/lib/store";
import { formatCount } from "@/lib/utils/format";

const SUGGESTIONS = [
  "Give me an overview of this model",
  "How many doors and windows are on each storey?",
  "Which walls are external? Isolate them.",
  "What is the wall and slab volume per storey?",
  "What data problems does this model have?",
];

export function AssistantPanel() {
  const engine = useEngine();
  const hasModels = useViewerStore((state) => state.models.length > 0);
  const items = useAssistantStore((state) => state.items);
  const busy = useAssistantStore((state) => state.busy);
  const configured = useAssistantStore((state) => state.configured);
  const model = useAssistantStore((state) => state.model);
  const usage = useAssistantStore((state) => state.usage);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void refreshAssistantStatus();
  }, []);

  // Follow new messages unless the reader has scrolled up.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [items, busy]);

  // Grow the box with its content, up to a few lines.
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(132, node.scrollHeight)}px`;
  }, [draft]);

  const ready = Boolean(engine) && configured === true && hasModels;
  const send = (question: string) => {
    if (!engine || !ready || busy || !question.trim()) return;
    pinned.current = true;
    setDraft("");
    void askAssistant(engine, question);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(draft);
    }
  };

  const last = items[items.length - 1];
  const waiting = busy && !(last?.kind === "tool" && last.status === "running");

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto"
      >
        {configured === false ? (
          <SetupNote />
        ) : items.length === 0 ? (
          <div className="p-3">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <Sparkles size={15} className="text-accent" />
              Ask about the model
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-fg-2">
              Ask in plain language. The assistant looks the answer up in the loaded model (counts, properties, quantities, checks) and can select, isolate or colour what it finds in the 3D view.
            </p>
            {hasModels ? (
              <div className="mt-3 flex flex-col gap-1.5">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={!ready}
                    onClick={() => send(suggestion)}
                    className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-[12px] text-fg-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : (
              <Callout className="mt-3">Open a model first. The assistant answers from the model that is loaded.</Callout>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 p-3" role="log" aria-live="polite" aria-label="Conversation">
            {groupItems(items).map((entry) =>
              Array.isArray(entry) ? <Steps key={entry[0].id} steps={entry} engine={engine} /> : <Row key={entry.id} item={entry} engine={engine} busy={busy} onRetry={send} />,
            )}
            {waiting ? (
              <div className="flex items-center gap-2 text-[12px] text-fg-3">
                <Spinner size={13} />
                Thinking
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="border-t border-line p-2.5">
        <div className={clsx("flex items-end gap-1.5 rounded-lg border bg-surface p-1.5 transition-colors", ready ? "border-line-strong focus-within:border-accent" : "border-line opacity-60")}>
          <textarea
            ref={input}
            rows={1}
            value={draft}
            disabled={!ready}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={configured === false ? "Add an API key to use the assistant" : hasModels ? "Ask about the model" : "Open a model to ask about it"}
            aria-label="Question for the assistant"
            style={{ outline: "none" }}
            className="scroll-thin max-h-[132px] min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-0.5 text-[12.5px] leading-[20px] text-fg outline-none placeholder:text-fg-3 disabled:cursor-not-allowed"
          />
          {busy ? (
            <button
              type="button"
              onClick={stopAssistant}
              title="Stop"
              aria-label="Stop"
              className="grid size-7 shrink-0 place-items-center rounded-md border border-line-strong bg-surface text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send(draft)}
              disabled={!ready || !draft.trim()}
              title="Send (Enter)"
              aria-label="Send"
              className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-start justify-between gap-2">
          <p className="text-[10.5px] leading-snug text-fg-3">
            Questions and the model data needed to answer them are sent to Anthropic{model ? ` (${model})` : ""}. Geometry and the file stay in your browser.
            {usage.input + usage.output > 0 ? <span className="tabular"> {`${formatTokens(usage.input)} tokens in, ${formatTokens(usage.output)} out this chat.`}</span> : null}
          </p>
          {items.length > 0 ? (
            <IconButton label="New chat" size="sm" onClick={() => resetAssistant()}>
              <SquarePen size={13} />
            </IconButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Runs of consecutive tool steps become one group, so long runs can fold. */
function groupItems(items: ChatItem[]): (ChatItem | ToolItem[])[] {
  const grouped: (ChatItem | ToolItem[])[] = [];
  for (const item of items) {
    const previous = grouped[grouped.length - 1];
    if (item.kind === "tool") {
      if (Array.isArray(previous)) previous.push(item);
      else grouped.push([item]);
    } else grouped.push(item);
  }
  return grouped;
}

const VISIBLE_STEPS = 4;

function Steps({ steps, engine }: { steps: ToolItem[]; engine: ViewerEngine | null }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = expanded ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
  return (
    <div className="flex flex-col gap-0.5">
      {steps.length > VISIBLE_STEPS ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-[11.5px] text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <ChevronRight size={12} className={clsx("transition-transform", expanded && "rotate-90")} />
          {expanded ? "Hide earlier steps" : `${hidden} earlier step${hidden === 1 ? "" : "s"}`}
        </button>
      ) : null}
      {steps.slice(hidden).map((step) => (
        <Row key={step.id} item={step} engine={engine} busy={false} onRetry={() => {}} />
      ))}
    </div>
  );
}

function formatTokens(count: number) {
  return count >= 10_000 ? `${Math.round(count / 1000)}k` : count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function Row({ item, engine, busy, onRetry }: { item: ChatItem; engine: ViewerEngine | null; busy: boolean; onRetry: (question: string) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-6 self-end whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-surface-3 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-fg">{item.text}</div>
      );
    case "assistant":
      return <Markdown text={item.text} className="min-w-0 break-words" />;
    case "tool": {
      const count = item.items ? Object.values(item.items).reduce((sum, ids) => sum + ids.length, 0) : 0;
      const icon =
        item.status === "running" ? <Spinner size={12} /> : item.status === "error" ? <CircleAlert size={12} className="text-warn" /> : <Check size={12} className="text-fg-3" />;
      if (engine && item.status === "done" && item.items && count > 0) {
        const elements = item.items;
        return (
          <button
            type="button"
            onClick={() => void engine.select(elements, { zoom: true })}
            title={`Select ${count === 1 ? "this element" : `these ${formatCount(count)} elements`} in 3D`}
            className="group flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-left text-[11.5px] text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {icon}
            <span>{item.summary}</span>
            <MousePointerClick size={12} className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        );
      }
      return (
        <div className="flex items-center gap-1.5 px-1 py-0.5 text-[11.5px] text-fg-3">
          {icon}
          <span className="min-w-0 break-words">{item.summary}</span>
        </div>
      );
    }
    case "notice":
      return (
        <Callout tone={item.tone === "bad" ? "bad" : item.tone === "warn" ? "warn" : "info"}>
          <div>{item.text}</div>
          {item.retry ? (
            <Button size="sm" className="mt-1.5" icon={<RotateCcw size={12} />} disabled={busy} onClick={() => onRetry(item.retry ?? "")}>
              Try again
            </Button>
          ) : null}
        </Callout>
      );
  }
}

function SetupNote() {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
        <Sparkles size={15} className="text-accent" />
        Set up the assistant
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-fg-2">
        The assistant answers questions about the loaded model with Claude. It needs an Anthropic API key, which stays on your machine in a local file that is never sent to the browser.
      </p>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-[12px] leading-relaxed text-fg-2 marker:text-fg-3">
        <li>
          Create a file named <code className="rounded bg-surface-2 px-1 font-mono text-[11.5px] text-fg">.env.local</code> in the project folder (copy <code className="rounded bg-surface-2 px-1 font-mono text-[11.5px] text-fg">.env.example</code>).
        </li>
        <li>
          Add your key:
          <pre className="scroll-thin mt-1 overflow-x-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-[11.5px] text-fg">ANTHROPIC_API_KEY=sk-ant-...</pre>
        </li>
        <li>
          Restart <code className="rounded bg-surface-2 px-1 font-mono text-[11.5px] text-fg">npm run dev</code>, then reopen this tab.
        </li>
      </ol>
      <p className="mt-3 text-[11.5px] leading-relaxed text-fg-3">
        Optional: set <code className="font-mono">ANTHROPIC_MODEL</code> to choose the model. Usage is billed to your Anthropic account. Everything else in the app works without a key.
      </p>
      <Button className="mt-3" size="sm" icon={<RotateCcw size={12} />} onClick={() => void refreshAssistantStatus()}>
        Check again
      </Button>
    </div>
  );
}
