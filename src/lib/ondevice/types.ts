// What the on-device assistant is asked: a system prompt, the user's part,
// and the JSON Schema its answer must follow (the engines constrain the
// output to it, so an answer always parses).

export interface JsonTask {
  /** What the task is called in progress messages ("Suggesting room types"). */
  label: string;
  system: string;
  /** Worked examples, given as earlier turns of the conversation (small models follow them closely). */
  examples?: { user: string; answer: string }[];
  user: string;
  schema: Record<string, unknown>;
  /** Upper bound on the answer's length, in tokens. */
  maxTokens: number;
}
