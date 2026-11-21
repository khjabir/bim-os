// The assistant's agent loop. Each question goes to /api/assistant; when the
// model asks for tools they run here in the browser and their results go back,
// until the model answers in plain text.

import type { PlainIdMap } from "@/lib/store";
import { executeTool, SYSTEM_PROMPT, TOOL_DEFINITIONS, type AssistantRuntime } from "./tools";

/** A Messages API content block. Unknown kinds (thinking and so on) are passed back untouched. */
export interface ApiBlock {
  type: string;
  [key: string]: unknown;
}

export interface ApiMessage {
  role: "user" | "assistant";
  content: ApiBlock[];
}

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-end"; id: string; name: string; summary: string; isError: boolean; items?: PlainIdMap }
  | { type: "notice"; tone: "info" | "warn" | "bad"; text: string }
  | { type: "usage"; input: number; output: number };

export class AssistantRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AssistantRequestError";
  }
}

/** API calls allowed for one question, tool rounds included. */
const MAX_ROUNDS = 14;
/** Past exchanges kept with their full tool traffic; older ones shrink to question and answer. */
const FULL_EXCHANGES = 2;
const MAX_RESULT_CHARS = 40_000;

const text = (value: string): ApiBlock => ({ type: "text", text: value });

function textOf(blocks: ApiBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n\n")
    .trim();
}

/**
 * Conversation memory. Kept as one list of messages per question so that an
 * unfinished or failed question can be dropped, and old ones compacted,
 * without ever leaving a tool call without its result.
 */
export class Conversation {
  private exchanges: ApiMessage[][] = [];

  get length() {
    return this.exchanges.length;
  }

  clear() {
    this.exchanges = [];
  }

  begin(blocks: ApiBlock[]): ApiMessage[] {
    this.compact();
    const exchange: ApiMessage[] = [{ role: "user", content: blocks }];
    this.exchanges.push(exchange);
    return exchange;
  }

  /** Forgets the question in progress (used when a request fails or is refused). */
  dropLast() {
    this.exchanges.pop();
  }

  /** Everything as one alternating message list. */
  messages(): ApiMessage[] {
    const flat: ApiMessage[] = [];
    for (const exchange of this.exchanges) {
      for (const message of exchange) {
        const previous = flat[flat.length - 1];
        // A stopped question ends on a user message; fold the next one into it.
        if (previous && previous.role === message.role) previous.content = [...previous.content, ...message.content];
        else flat.push({ role: message.role, content: [...message.content] });
      }
    }
    return flat;
  }

  private compact() {
    const cutoff = this.exchanges.length - FULL_EXCHANGES;
    for (let i = 0; i < cutoff; i++) {
      const exchange = this.exchanges[i];
      if (exchange.length <= 2) continue;
      const question = exchange[0].content.filter((block) => block.type === "text");
      const final = exchange[exchange.length - 1];
      const answer = final.role === "assistant" ? textOf(final.content) : "";
      this.exchanges[i] = [
        { role: "user", content: question.length > 0 ? question : [text("(question)")] },
        { role: "assistant", content: [text(answer || "(This question was stopped before it was answered.)")] },
      ];
    }
  }
}

interface ApiReply {
  content: ApiBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
}

async function request(messages: ApiMessage[], signal: AbortSignal): Promise<ApiReply> {
  const response = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ system: SYSTEM_PROMPT, tools: TOOL_DEFINITIONS, messages }),
    signal,
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Fall through with the status text.
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string" ? (payload as { error: string }).error : `The assistant request failed (${response.status}).`;
    throw new AssistantRequestError(message, response.status);
  }
  const reply = payload as ApiReply | null;
  if (!reply || !Array.isArray(reply.content)) throw new AssistantRequestError("The assistant returned an unreadable reply.", 502);
  return reply;
}

function serialise(output: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(output);
  } catch {
    json = JSON.stringify({ error: "The result could not be serialised." });
  }
  return json.length > MAX_RESULT_CHARS ? `${json.slice(0, MAX_RESULT_CHARS)}… [truncated: the result was too large; narrow the filters]` : json;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

export interface AskOptions {
  conversation: Conversation;
  runtime: AssistantRuntime;
  question: string;
  /** One line about what is loaded and selected right now. */
  viewerState: string;
  signal: AbortSignal;
  onEvent: (event: TurnEvent) => void;
}

/**
 * Answers one question. Resolves when the model has finished; rejects with an
 * AbortError when the user stops it, or with AssistantRequestError when the
 * API call fails (in which case the question is removed from memory again).
 */
export async function ask({ conversation, runtime, question, viewerState, signal, onEvent }: AskOptions): Promise<void> {
  const exchange = conversation.begin([text(`<viewer_state>\n${viewerState}\n</viewer_state>`), text(question)]);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let reply: ApiReply;
    try {
      reply = await request(conversation.messages(), signal);
    } catch (error) {
      if (isAbort(error)) {
        // The memory is still consistent: it ends on a user message.
        exchange[exchange.length - 1].content.push(text("(The user stopped this request before it finished.)"));
        throw error;
      }
      conversation.dropLast();
      throw error;
    }

    const usage = reply.usage;
    if (usage) {
      onEvent({
        type: "usage",
        input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        output: usage.output_tokens ?? 0,
      });
    }

    const content = reply.content;
    const said = textOf(content);
    const calls = content.filter((block) => block.type === "tool_use");
    const reason = reply.stop_reason;

    if (reason === "refusal") {
      conversation.dropLast();
      onEvent({ type: "notice", tone: "warn", text: "The model declined to answer this request." });
      return;
    }
    if (reason === "model_context_window_exceeded") {
      conversation.dropLast();
      onEvent({ type: "notice", tone: "warn", text: "This conversation no longer fits in the model's context window. Start a new chat." });
      return;
    }

    if (said) onEvent({ type: "text", text: said });

    if (reason === "max_tokens") {
      // A tool call may have been cut in half, so keep only the text.
      exchange.push({ role: "assistant", content: [text(said || "(The reply was cut off.)")] });
      onEvent({ type: "notice", tone: "warn", text: "The reply hit the length limit and was cut off. Ask for the rest, or for a shorter answer." });
      return;
    }

    if (reason === "pause_turn") {
      // The API paused a long turn: hand the content back unchanged to resume it.
      exchange.push({ role: "assistant", content });
      continue;
    }

    if (calls.length === 0) {
      exchange.push({ role: "assistant", content: content.length > 0 ? content : [text("(no answer)")] });
      if (!said) onEvent({ type: "notice", tone: "info", text: "The model returned an empty answer. Try rephrasing the question." });
      return;
    }

    if (round === MAX_ROUNDS - 1) {
      // Out of rounds while the model still wants tools: close the exchange on text.
      exchange.push({ role: "assistant", content: [text(said || "(Stopped before an answer was reached.)")] });
      onEvent({ type: "notice", tone: "warn", text: `Stopped after ${MAX_ROUNDS} steps without a final answer. Try a narrower question.` });
      return;
    }

    exchange.push({ role: "assistant", content });
    const results: ApiBlock[] = [];
    for (const call of calls) {
      const id = String(call.id);
      const name = String(call.name);
      if (signal.aborted) {
        results.push({ type: "tool_result", tool_use_id: id, content: "Cancelled by the user.", is_error: true });
        continue;
      }
      onEvent({ type: "tool-start", id, name });
      const outcome = await executeTool(runtime, name, (call.input ?? {}) as Record<string, unknown>);
      onEvent({ type: "tool-end", id, name, summary: outcome.summary, isError: Boolean(outcome.isError), items: outcome.items });
      results.push({ type: "tool_result", tool_use_id: id, content: serialise(outcome.output), ...(outcome.isError ? { is_error: true } : {}) });
    }
    if (signal.aborted) {
      results.push(text("(The user stopped this request before it finished.)"));
      exchange.push({ role: "user", content: results });
      throw new DOMException("Stopped", "AbortError");
    }
    if (round === MAX_ROUNDS - 2) results.push(text("You have one reply left for this question. Answer now from what you have gathered and do not call more tools."));
    exchange.push({ role: "user", content: results });
  }
}
