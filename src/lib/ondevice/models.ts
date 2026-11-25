// The models the on-device assistant can use. Open models run in the browser
// with WebLLM (WebGPU), downloaded once from Hugging Face (mlc-ai) and kept in
// the browser's cache; Chrome's own built-in model is used when the browser
// has one. Nothing is sent anywhere to answer.

export type EngineKind = "webllm" | "chrome";

export interface AssistantModel {
  id: string;
  engine: EngineKind;
  label: string;
  note: string;
  /** WebLLM model ids: for GPUs with 16-bit shader maths, and without. */
  webllm?: { f16: string; f32: string };
  /** Download, megabytes (weights, tokenizer and the WebGPU library). */
  sizeMB?: number;
  maker: string;
  licence: string;
  /** Where its licence is published. */
  licenceUrl: string;
}

export const ASSISTANT_MODELS: AssistantModel[] = [
  {
    id: "qwen3.5-2b",
    engine: "webllm",
    label: "Qwen3.5 2B",
    note: "Recommended: a balance of download size, speed and accuracy. Needs about 2.2 GB of graphics memory.",
    webllm: { f16: "Qwen3.5-2B-q4f16_1-MLC", f32: "Qwen3.5-2B-q4f32_1-MLC" },
    sizeMB: 1090,
    maker: "Alibaba Qwen",
    licence: "Apache-2.0",
    licenceUrl: "https://huggingface.co/Qwen/Qwen3.5-2B",
  },
  {
    id: "qwen3.5-0.8b",
    engine: "webllm",
    label: "Qwen3.5 0.8B",
    note: "Smallest and fastest, for older computers; much less accurate. Needs about 1.6 GB of graphics memory.",
    webllm: { f16: "Qwen3.5-0.8B-q4f16_1-MLC", f32: "Qwen3.5-0.8B-q4f32_1-MLC" },
    sizeMB: 455,
    maker: "Alibaba Qwen",
    licence: "Apache-2.0",
    licenceUrl: "https://huggingface.co/Qwen/Qwen3.5-0.8B",
  },
  {
    id: "qwen3.5-4b",
    engine: "webllm",
    label: "Qwen3.5 4B",
    note: "Most accurate (in tests it typed 46 of 50 unusual room names, the 2B model 31), and slower. Needs about 3.9 GB of graphics memory.",
    webllm: { f16: "Qwen3.5-4B-q4f16_1-MLC", f32: "Qwen3.5-4B-q4f32_1-MLC" },
    sizeMB: 2400,
    maker: "Alibaba Qwen",
    licence: "Apache-2.0",
    licenceUrl: "https://huggingface.co/Qwen/Qwen3.5-4B",
  },
  {
    id: "chrome",
    engine: "chrome",
    label: "Chrome's built-in model",
    note: "Gemini Nano, when this Chrome has it: Chrome downloads and updates it itself.",
    maker: "Google",
    licence: "part of Chrome (Prompt API)",
    licenceUrl: "https://developer.chrome.com/docs/ai/prompt-api",
  },
];

export const DEFAULT_MODEL = "qwen3.5-2b";

export function assistantModel(id: string | null | undefined): AssistantModel {
  return ASSISTANT_MODELS.find((m) => m.id === id) ?? ASSISTANT_MODELS.find((m) => m.id === DEFAULT_MODEL)!;
}
