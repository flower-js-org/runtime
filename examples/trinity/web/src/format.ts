// Formatting numbers, times and tool inputs. No DOM here, so Node tests import it.

export function formatDollars(nanos: number | null | undefined): string {
  if (nanos === null || nanos === undefined) return "—";
  const dollars = nanos / 1e9;
  if (dollars !== 0 && Math.abs(dollars) < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A dollar amount typed by a user, as nanodollars; empty means no limit. */
export function dollarsToNanos(text: string | null | undefined): number | null {
  const trimmed = String(text ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (trimmed === "") return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) throw new RangeError(`Invalid dollar amount ${JSON.stringify(text)}`);
  return Math.round(dollars * 1e9);
}

export function nanosToDollars(nanos: number | null | undefined): string {
  return nanos === null || nanos === undefined ? "" : String(Math.round(nanos / 1e7) / 100);
}

export function formatTokens(count: number | null | undefined): string {
  const value = Number(count ?? 0);
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
  return String(value);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "";
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 7 * 86_400) return `${Math.round(seconds / 86_400)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(now - at > 300 * 86_400_000 ? { year: "numeric" } : {}) });
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dateTime(at: number | null | undefined): string {
  return at ? new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export const isoTime = (at: number) => new Date(at).toISOString();

export function oneLine(text: string, max: number): string {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A short description of a tool call from its input, for collapsed views. */
export function toolSummary(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "";
  const fields = input as Record<string, unknown>;
  const preferred = ["command", "path", "description", "question", "query", "url", "title", "name", "id", "key"];
  const value = preferred.map((field) => fields[field]).find((each) => typeof each === "string")
    ?? Object.values(fields).find((each) => typeof each === "string");
  return typeof value === "string" ? oneLine(value, 140) : "";
}

/** A tool input for display: a lone command as itself, anything else as JSON. */
export function inputText(input: unknown): string {
  if (input && typeof input === "object" && typeof (input as { command?: unknown }).command === "string" && Object.keys(input).length === 1) {
    return (input as { command: string }).command;
  }
  return JSON.stringify(input, null, 2);
}

export const STATUS_LABELS: Record<string, string> = { idle: "Idle", working: "Working", waiting_on_user: "Needs you", halted: "Halted", error: "Error" };

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
