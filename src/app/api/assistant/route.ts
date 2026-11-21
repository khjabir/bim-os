// Thin server-side proxy between the Assistant panel and the Claude Messages API.
//
// The API key stays on the server (ANTHROPIC_API_KEY in .env.local). The tools
// themselves run in the browser against the loaded model: this route only
// forwards the conversation and returns the model's next turn.
//
// This endpoint spends your API credit. It only accepts same-origin requests,
// which is enough for local use; put real authentication in front of it before
// deploying the app anywhere public.

import Anthropic from "@anthropic-ai/sdk";
import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_MESSAGES = 400;
const MAX_TOKENS = 8192;
const MAX_TOOLS = 24;
const MAX_BODY_CHARS = 2_500_000;

function model() {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

/** Marks the end of the conversation as a cache breakpoint, so the next tool round reads it from cache. */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return messages;
  const blocks: Anthropic.ContentBlockParam[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1];
  if (!tail || (tail.type !== "text" && tail.type !== "tool_result")) return messages;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/** Lets the panel know whether a key is configured, without revealing it. */
export async function GET() {
  return NextResponse.json({ configured: Boolean(process.env.ANTHROPIC_API_KEY), model: model() });
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the server." }, { status: 503 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "The conversation is too long. Start a new chat." }, { status: 413 });
  let body: { system?: unknown; messages?: unknown; tools?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const { system, messages, tools } = body;
  if (typeof system !== "string" || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "Expected { system, messages, tools }." }, { status: 400 });
  }
  if (messages.length > MAX_MESSAGES) return NextResponse.json({ error: "The conversation is too long. Start a new chat." }, { status: 413 });
  if (tools !== undefined && (!Array.isArray(tools) || tools.length > MAX_TOOLS)) {
    return NextResponse.json({ error: "Invalid tool list." }, { status: 400 });
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: model(),
      max_tokens: MAX_TOKENS,
      // The tool list and system prompt are identical on every turn, and each
      // tool round re-sends the conversation so far: cache both prefixes.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: withCacheBreakpoint(messages as Anthropic.MessageParam[]),
      tools: tools as Anthropic.Tool[] | undefined,
    });
    return NextResponse.json({
      content: response.content,
      stop_reason: response.stop_reason,
      usage: response.usage,
      model: response.model,
    });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      const status = typeof error.status === "number" ? error.status : 502;
      const hint =
        status === 401 ? "The API key was rejected. Check ANTHROPIC_API_KEY."
        : status === 404 ? `Model "${model()}" was not found. Set ANTHROPIC_MODEL to a model your key can use.`
        : status === 429 ? "Rate limited. Wait a moment and try again."
        : status === 529 ? "The API is overloaded. Try again shortly."
        : error.message;
      return NextResponse.json({ error: hint }, { status: status >= 400 && status < 600 ? status : 502 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Request failed." }, { status: 502 });
  }
}
