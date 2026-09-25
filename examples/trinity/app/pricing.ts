import type { Usage } from "./model.ts";

interface Rates { input: number; output: number; cacheRead: number; cacheWrite: number }

/** US dollars per million tokens, Claude API list prices. Cache writes use the 5-minute rate. */
const RATES: Record<string, Rates> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Unknown models are charged the highest rates, so a new model never looks free. */
const UNKNOWN = RATES["claude-fable-5-1"]!;

export function ratesFor(model: string): Rates {
  return RATES[model] ?? RATES[model.replace(/-\d{8}$/, "")] ?? UNKNOWN;
}

/** Cost in nanodollars: $1 per million tokens is 1,000 nanodollars per token. */
export function costNanos(model: string, usage: Usage): number {
  const rates = ratesFor(model);
  const dollarsPerMillion = usage.input * rates.input + usage.output * rates.output
    + usage.cacheRead * rates.cacheRead + usage.cacheWrite * rates.cacheWrite;
  return Math.round(1_000 * dollarsPerMillion);
}
