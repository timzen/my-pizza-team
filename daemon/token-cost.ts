/**
 * daemon/token-cost.ts — Rough token-cost estimation shared by the task and
 * agent routes. Cost per 1M tokens (input, output) for common models.
 */

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-3": { input: 0.25, output: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.80, output: 4.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "o3": { input: 10.0, output: 40.0 },
  "o3-mini": { input: 1.10, output: 4.40 },
};

export function estimateTokenCost(model: string, inputTokens: number, outputTokens: number): number {
  let costs = MODEL_COSTS[model];
  if (!costs) {
    const key = Object.keys(MODEL_COSTS).find((k) => model.startsWith(k) || model.includes(k));
    costs = key ? MODEL_COSTS[key] : { input: 3.0, output: 15.0 };
  }
  const c = costs ?? { input: 3.0, output: 15.0 };
  return (inputTokens * c.input + outputTokens * c.output) / 1_000_000;
}
