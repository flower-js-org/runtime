import { v, type Json, type QueryContext, type Schema } from "@flower-js/sdk";
import { listAutomations, removeAutomation, saveAutomation } from "./automations.ts";
import { formatTime } from "./calendar.ts";
import { append } from "./log.ts";
import { receive } from "./loop.ts";
import { memoryPath, memoryScope } from "./memories.ts";
import type { Approval, Call, McpCall, Session, ToolDefinition, ToolOutcome } from "./model.ts";
import { automations, mcpCatalog, mcpServers, memories } from "./store.ts";
import { newSession, type Tx } from "./tx.ts";

export interface Tool<I = any> {
  readonly name: string;
  readonly description: string;
  /** JSON Schema offered to the model; `input` enforces the same contract. */
  readonly schema: Json;
  readonly input: Schema<I>;
  readonly approval?: Approval;
  /** What the user is asked to approve or answer. */
  readonly prompt?: (input: I) => string;
  /** Inline tools run inside the mutation that admits the call; the others are jobs. */
  readonly runsOn: "inline" | "computer" | "service";
  /** Inline tools only. "async" leaves the call running until something else resolves it. */
  readonly run?: (tx: Tx, session: Session, input: I, call: Call) => ToolOutcome | "async";
  /** Safe to run again when a worker stops without reporting. */
  readonly idempotent: boolean;
  readonly timeoutMs?: (input: I) => number;
  /** Whether this call returns at once and reports later as a background result. */
  readonly background?: (input: I) => boolean;
  readonly available?: (session: Session) => boolean;
  readonly mcp?: McpCall;
}

const tool = <I>(spec: Tool<I>): Tool<I> => spec;
const ok = (content: string): ToolOutcome => ({ content, isError: false });
const failed = (content: string): ToolOutcome => ({ content, isError: true });
const topLevel = (session: Session) => session.parent === null;
const object = (properties: Record<string, Json>, required: string[] = []): Json => ({ type: "object", additionalProperties: false, required, properties });

const path = v.string({ min: 1, max: 4_096 });
const scopeProperty = { type: "string", enum: ["org", "user"], description: "Shared with the organization, or private to the user this session works for. Defaults to user." };
const scopeInput = v.optional(v.enum(["org", "user"]));

const conversation = [
  tool({
    name: "set_title",
    description: "Set a short title for this session, describing what the user wants done.",
    schema: object({ title: { type: "string", minLength: 1, maxLength: 120 } }, ["title"]),
    input: v.object({ title: v.string({ min: 1, max: 120 }) }),
    runsOn: "inline",
    idempotent: true,
    run(tx, session, { title }) {
      session.title = title;
      append(tx.ctx, session, { type: "title", title });
      return ok("Title set.");
    },
  }),
  tool({
    name: "ask_user",
    description: "Ask the user a question and wait for their answer. Use it only when you cannot proceed without their input.",
    schema: object({ question: { type: "string", minLength: 1, maxLength: 4_000 } }, ["question"]),
    input: v.object({ question: v.string({ min: 1, max: 4_000 }) }),
    approval: "elicitation",
    prompt: ({ question }) => question,
    runsOn: "inline",
    idempotent: true,
    available: topLevel,
  }),
];

const computer = [
  tool({
    name: "list_files",
    description: "List the entries of a directory in the workspace. Directories end with a slash.",
    schema: object({ path: { type: "string", description: "Relative to the workspace root; defaults to the root." } }),
    input: v.object({ path: v.optional(path) }),
    runsOn: "computer",
    idempotent: true,
  }),
  tool({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace, optionally a range of lines.",
    schema: object({
      path: { type: "string", description: "Relative to the workspace root." },
      offset: { type: "integer", minimum: 1, description: "First line to return, starting at 1." },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines." },
    }, ["path"]),
    input: v.object({ path, offset: v.optional(v.int({ min: 1 })), limit: v.optional(v.int({ min: 1 })) }),
    runsOn: "computer",
    idempotent: true,
  }),
  tool({
    name: "write_file",
    description: "Create or replace a UTF-8 text file in the workspace, creating parent directories.",
    schema: object({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    input: v.object({ path, content: v.string({ max: 4_000_000 }) }),
    approval: "permission",
    prompt: ({ path, content }) => `Write ${content.length} characters to ${path}`,
    runsOn: "computer",
    idempotent: false,
  }),
  tool({
    name: "bash",
    description: "Run a bash command in the workspace root and return its exit code and output. Set background to start a long command and get its output later as a message.",
    schema: object({
      command: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: 3_600_000, description: "Defaults to 120000." },
      background: { type: "boolean", description: "Return at once; the result arrives as a message when the command ends." },
    }, ["command"]),
    input: v.object({ command: v.string({ min: 1, max: 100_000 }), timeoutMs: v.optional(v.int({ min: 1_000, max: 3_600_000 })), background: v.optional(v.boolean()) }),
    approval: "permission",
    prompt: ({ command }) => `Run: ${command}`,
    runsOn: "computer",
    idempotent: false,
    timeoutMs: ({ timeoutMs }) => (timeoutMs ?? 120_000) + 30_000,
    background: ({ background }) => background === true,
  }),
];

const service = [
  tool({
    name: "read_output",
    description: "Read part of a long tool output that was stored instead of returned in full.",
    schema: object({
      key: { type: "string", description: "The stored output's key, as given in the truncated result." },
      offset: { type: "integer", minimum: 0, description: "First character to return. Defaults to 0." },
      limit: { type: "integer", minimum: 1, maximum: 200_000, description: "Characters to return. Defaults to 50000." },
    }, ["key"]),
    input: v.object({ key: v.string({ pattern: /^sha256\/[0-9a-f]{64}$/ }), offset: v.optional(v.int({ min: 0 })), limit: v.optional(v.int({ min: 1, max: 200_000 })) }),
    runsOn: "service",
    idempotent: true,
  }),
];

const delegation = [
  tool({
    name: "subagent",
    description: "Delegate a self-contained task to a subagent with its own context. It sees only the prompt you give it and returns its final answer as this call's result. Several subagents run in parallel when called together.",
    schema: object({
      description: { type: "string", maxLength: 200, description: "A few words shown to the user." },
      prompt: { type: "string", description: "The complete task, with everything the subagent needs to know." },
      model: { type: "string", description: "A different model for this task. Defaults to this session's model." },
    }, ["description", "prompt"]),
    input: v.object({ description: v.string({ min: 1, max: 200 }), prompt: v.string({ min: 1, max: 200_000 }), model: v.optional(v.string({ min: 1, max: 128 })) }),
    runsOn: "inline",
    idempotent: false,
    available: topLevel,
    run(tx, session, { prompt, model }, call) {
      const child = newSession(tx, {
        id: `${session.id}.${call.id}`.slice(0, 128),
        org: session.org,
        createdBy: session.createdBy,
        model: model ?? session.model,
        computer: session.computer,
        private: session.private,
        parent: { session: session.id, call: call.id },
        allow: session.allow,
        autoApprove: session.autoApprove,
        webTools: session.webTools,
        system: "You are a subagent. Complete the task you are given and reply with your findings; the user does not see this conversation.",
      });
      call.child = child.id;
      append(tx.ctx, session, { type: "subagent", call: call.id, session: child.id });
      receive(tx, child, { id: `${child.id}:task`, text: prompt, steer: false, at: tx.ctx.now(), attachments: [], author: null, result: null });
      return "async";
    },
  }),
];

const memory = [
  tool({
    name: "memory_list",
    description: "List memory files. Memory persists across sessions; index.md of each scope is shown at the start of every turn.",
    schema: object({ scope: scopeProperty }),
    input: v.object({ scope: scopeInput }),
    runsOn: "inline",
    idempotent: true,
    run(tx, session, { scope }) {
      const files = tx.ctx.query(memories.by("byScope").eq([session.org, memoryScope(session, scope)]));
      if (files.length === 0) return ok("(no memory files)");
      return ok(files.map((file) => `${file.path} (${file.content.length} characters)`).sort().join("\n"));
    },
  }),
  tool({
    name: "memory_read",
    description: "Read a memory file.",
    schema: object({ path: { type: "string" }, scope: scopeProperty }, ["path"]),
    input: v.object({ path: v.string({ min: 1, max: 256 }), scope: scopeInput }),
    runsOn: "inline",
    idempotent: true,
    run(tx, session, input) {
      const file = tx.ctx.get(memories, [session.org, memoryScope(session, input.scope), memoryPath(input.path)]);
      return file === null ? failed(`No memory file ${input.path}.`) : ok(file.content);
    },
  }),
  tool({
    name: "memory_write",
    description: "Create or replace a memory file. Keep index.md short: it is shown at the start of every turn and should point to the other files.",
    schema: object({ path: { type: "string" }, content: { type: "string" }, scope: scopeProperty }, ["path", "content"]),
    input: v.object({ path: v.string({ min: 1, max: 256 }), content: v.string({ max: 100_000 }), scope: scopeInput }),
    runsOn: "inline",
    idempotent: true,
    run(tx, session, input) {
      const scope = memoryScope(session, input.scope);
      const file = memoryPath(input.path);
      tx.ctx.set(memories, [session.org, scope, file], { org: session.org, scope, path: file, content: input.content, updatedAt: tx.ctx.now(), updatedBy: session.createdBy });
      return ok(`Saved ${file}.`);
    },
  }),
];

const scheduling = [
  tool({
    name: "create_automation",
    description: "Schedule a prompt to run as a new session on a cron schedule (minute hour day month weekday), for example daily reports.",
    schema: object({
      name: { type: "string", maxLength: 200 },
      schedule: { type: "string", description: "Five-field cron expression, or @daily, @hourly and the like." },
      offsetMinutes: { type: "integer", description: "The schedule's UTC offset in minutes, e.g. -300 for New York in winter. Defaults to 0 (UTC)." },
      prompt: { type: "string" },
    }, ["name", "schedule", "prompt"]),
    input: v.object({
      name: v.string({ min: 1, max: 200 }),
      schedule: v.string({ min: 1, max: 200 }),
      offsetMinutes: v.optional(v.int({ min: -1_080, max: 1_080 })),
      prompt: v.string({ min: 1, max: 100_000 }),
    }),
    approval: "permission",
    prompt: ({ name, schedule }) => `Create automation "${name}" running ${schedule}`,
    runsOn: "inline",
    idempotent: true,
    available: topLevel,
    run(tx, session, input, call) {
      const saved = saveAutomation(tx.ctx, {
        org: session.org,
        id: `a-${call.id}`.slice(0, 128),
        name: input.name,
        schedule: input.schedule,
        offsetMinutes: input.offsetMinutes ?? 0,
        prompt: input.prompt,
        model: session.model,
        computer: session.computer,
        enabled: true,
        createdBy: session.createdBy,
      });
      return ok(`Created automation ${saved.id}; it next runs at ${formatTime(saved.nextAt ?? 0)}.`);
    },
  }),
  tool({
    name: "list_automations",
    description: "List this organization's automations.",
    schema: object({}),
    input: v.object({}),
    runsOn: "inline",
    idempotent: true,
    available: topLevel,
    run(tx, session) {
      const list = listAutomations(tx.ctx, session.org);
      if (list.length === 0) return ok("(no automations)");
      return ok(list.map((each) => `${each.id}: "${each.name}" ${each.schedule}${each.enabled ? "" : " (disabled)"} — ${each.prompt.slice(0, 200)}`).join("\n"));
    },
  }),
  tool({
    name: "delete_automation",
    description: "Delete an automation by ID.",
    schema: object({ id: { type: "string" } }, ["id"]),
    input: v.object({ id: v.string({ min: 1, max: 128 }) }),
    approval: "permission",
    prompt: ({ id }) => `Delete automation ${id}`,
    runsOn: "inline",
    idempotent: true,
    available: topLevel,
    run(tx, session, { id }) {
      if (tx.ctx.get(automations, [session.org, id]) === null) return failed(`No automation ${id}.`);
      removeAutomation(tx.ctx, session.org, id);
      return ok(`Deleted ${id}.`);
    },
  }),
];

const BUILT_IN: readonly Tool[] = [...conversation, ...computer, ...service, ...delegation, ...memory, ...scheduling];
const BY_NAME = new Map(BUILT_IN.map((each) => [each.name, each]));
const anyArguments = v.record(v.json());
const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : 1);

/** Tool names allow [a-zA-Z0-9_-], up to 64 characters. */
function mcpToolName(server: string, name: string): string {
  return `mcp__${server}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** The tools of the organization's enabled MCP servers whose catalogs have been read. The servers validate the arguments. */
function mcpTools(ctx: QueryContext, session: Session): Tool[] {
  const servers = ctx.query(mcpServers.by("byOrg").eq(session.org)).filter((server) => server.enabled).sort(byName);
  return servers.flatMap((server) => {
    const catalog = ctx.get(mcpCatalog, [session.org, server.name]);
    if (catalog?.status !== "ready") return [];
    return [...catalog.value].sort(byName).map((entry): Tool => ({
      name: mcpToolName(server.name, entry.name),
      description: `${entry.description}\n\n(${server.name} MCP server)`.trim(),
      schema: entry.inputSchema,
      input: anyArguments,
      ...(server.trusted ? {} : { approval: "permission" as const, prompt: (input: Json) => `${server.name}: ${entry.name} ${JSON.stringify(input)}` }),
      runsOn: "service",
      idempotent: false,
      mcp: { server: server.name, tool: entry.name, url: server.url, headers: server.headers },
    }));
  });
}

export function resolveTool(ctx: QueryContext, session: Session, name: string): Tool | undefined {
  const builtIn = BY_NAME.get(name);
  if (builtIn !== undefined) return builtIn.available?.(session) === false ? undefined : builtIn;
  return name.startsWith("mcp__") ? mcpTools(ctx, session).find((each) => each.name === name) : undefined;
}

/** The tools offered to the model, in a stable order so the request prefix stays cacheable. */
export function toolDefinitions(ctx: QueryContext, session: Session): ToolDefinition[] {
  const offered: ToolDefinition[] = [...BUILT_IN.filter((each) => each.available?.(session) !== false), ...mcpTools(ctx, session)]
    .map((each) => ({ name: each.name, description: each.description, input_schema: each.schema }));
  if (session.webTools) {
    offered.push({ type: "web_search_20260209", name: "web_search", max_uses: 10 }, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 });
  }
  return offered;
}
