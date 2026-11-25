/// <reference lib="webworker" />
// The open models of the on-device assistant, off the main thread: WebLLM's
// engine runs here on WebGPU, so the page never loads the engine itself.
// Requests: load a model (with download progress), answer with JSON that
// follows a schema (constrained decoding: the answer always parses), stop,
// unload, and look up or remove the browser's copy of a model.

import { CreateMLCEngine, deleteModelAllInfoInCache, hasModelInCache, type MLCEngine } from "@mlc-ai/web-llm";
import { announceReady } from "@/lib/utils/worker-ready";
import type { WorkerReply, WorkerRequest } from "./workerTypes";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let engine: MLCEngine | null = null;
let loaded: string | null = null;

const reply = (msg: WorkerReply) => ctx.postMessage(msg);

async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.op) {
    case "load": {
      if (engine && loaded === req.modelId) return true;
      if (engine) {
        await engine.unload().catch(() => undefined);
        loaded = null;
      }
      const report = (p: { progress: number; text: string }) => reply({ id: req.id, progress: { progress: p.progress, text: p.text } });
      if (!engine) engine = await CreateMLCEngine(req.modelId, { initProgressCallback: report });
      else {
        engine.setInitProgressCallback(report);
        await engine.reload(req.modelId);
      }
      loaded = req.modelId;
      return true;
    }
    case "json": {
      if (!engine || !loaded) throw new Error("No model is loaded.");
      const started = performance.now();
      const answer = await engine.chat.completions.create({
        messages: [
          { role: "system", content: req.system },
          ...req.examples.flatMap((e) => [
            { role: "user" as const, content: e.user },
            { role: "assistant" as const, content: e.answer },
          ]),
          { role: "user", content: req.user },
        ],
        response_format: { type: "json_object", schema: JSON.stringify(req.schema) },
        max_tokens: req.maxTokens,
        temperature: 0,
        // Qwen models answer straight away instead of thinking first.
        extra_body: { enable_thinking: false },
      });
      const text = answer.choices[0]?.message?.content ?? "";
      return { text, seconds: (performance.now() - started) / 1000, promptTokens: answer.usage?.prompt_tokens ?? null, answerTokens: answer.usage?.completion_tokens ?? null, finish: answer.choices[0]?.finish_reason ?? null };
    }
    case "stop":
      engine?.interruptGenerate();
      return true;
    case "unload":
      if (engine) await engine.unload().catch(() => undefined);
      engine = null;
      loaded = null;
      return true;
    case "has": {
      const found: Record<string, boolean> = {};
      for (const id of req.modelIds) found[id] = await hasModelInCache(id).catch(() => false);
      return found;
    }
    case "delete":
      for (const id of req.modelIds) await deleteModelAllInfoInCache(id).catch(() => undefined);
      return true;
  }
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  handle(req).then(
    (result) => reply({ id: req.id, result }),
    (error: unknown) => reply({ id: req.id, error: error instanceof Error ? error.message : String(error) }),
  );
};

announceReady("assistant");
