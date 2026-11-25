// Messages between the page and the assistant's worker.

export type WorkerRequest =
  | { id: number; op: "load"; modelId: string }
  | { id: number; op: "json"; system: string; examples: { user: string; answer: string }[]; user: string; schema: Record<string, unknown>; maxTokens: number }
  | { id: number; op: "stop" }
  | { id: number; op: "unload" }
  | { id: number; op: "has"; modelIds: string[] }
  | { id: number; op: "delete"; modelIds: string[] };

export type WorkerReply =
  | { id: number; progress: { progress: number; text: string } }
  | { id: number; result: unknown }
  | { id: number; error: string };

export interface JsonReply {
  text: string;
  seconds: number;
  promptTokens: number | null;
  answerTokens: number | null;
  finish: string | null;
}
