import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { parseArgs, styleText, type ParseArgsOptionsConfig } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { FlowerClient, type FlowerFetch } from "@flower-js/sdk";
import type app from "../app/index.ts";
import type { Event } from "../app/model.ts";
import { loadSigningKey, signToken, type TokenClaims } from "./auth.ts";
import { blobStoreFromEnv } from "./blobs.ts";
import { runLlmWorker } from "./llm.ts";
import { runLocalWorker } from "./local.ts";
import { envSecrets } from "./mcp.ts";
import { http2Connections } from "./pool.ts";
import { runSandboxes } from "./sandbox.ts";
import { runService } from "./service.ts";
import { runSlack } from "./slack.ts";
import { setupSlack } from "./slack-setup.ts";
import { DEFAULT_PROFILE, runSim } from "./sim.ts";

const USAGE = `Usage: trinity <command>

Signing in (through the gateway at TRINITY_URL, default http://127.0.0.1:8080):
  login USER [--org ORG]                 development sign-in; saves the token
  org create ID NAME | org use ID | org list

Sessions:
  new [--model M] [--computer ID] [--private]   create a session and print its ID
  list                                          your organization's sessions
  send SESSION TEXT... [--steer]                send a message (--steer joins the running turn)
  watch SESSION                                 follow a session's log and streamed text
  approve SESSION CALL [--always] | deny SESSION CALL | answer SESSION CALL TEXT...
  halt SESSION [--background]

Slack (connected over Socket Mode):
  slack setup [--name Trinity] [--config-token T]   create the app, connect a workspace
  slack status                                      workspaces and linked accounts
  slack                                             run the Slack worker

Computers and tools:
  computer register ID [NAME]            register this machine and save its token
  local --computer ID [--workspace DIR]  run this computer's tools here
  mcp add NAME URL [--header K=V]... [--trusted] | mcp list

Workers (FLOWER_URL, default http://127.0.0.1:7101; a worker token from TRINITY_TOKEN
or minted with TRINITY_AUTH_KEY, default .dev/auth.pem):
  llm [--lanes N]    service    sandboxes
  sim [--speedup 20] [--stops 3] [--max-stops 12] [--computers 16] [--concurrency 2048]
                     a simulated model, and the computers sim-0…: no credentials, fast turns
  token --role worker|service [--sub NAME] [--ttl SECONDS]`;

type Client = FlowerClient<typeof app>;
interface Config { url: string; token: string | null; computers: Record<string, string> }

const root = new URL("..", import.meta.url).pathname;
const configPath = process.env.TRINITY_CONFIG ?? join(homedir(), ".config", "trinity", "config.json");
const env = process.env;

// Configuration and clients

async function readConfig(): Promise<Config> {
  const defaults: Config = { url: env.TRINITY_URL ?? "http://127.0.0.1:8080", token: null, computers: {} };
  try {
    return { ...defaults, ...JSON.parse(await readFile(configPath, "utf8")) };
  } catch {
    return defaults;
  }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Call one of the gateway's own endpoints. */
async function postGateway<T>(config: Config, path: string, body: unknown, token = config.token): Promise<T> {
  const response = await fetch(new URL(path, config.url), {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `${path} failed with ${response.status}`);
  return value;
}

/** Ask the gateway for a token. */
async function gateway(config: Config, path: string, body: unknown, token = config.token): Promise<string> {
  return (await postGateway<{ token: string }>(config, path, body, token)).token;
}

async function signedIn(): Promise<{ client: Client; config: Config }> {
  const config = await readConfig();
  const token = env.TRINITY_TOKEN ?? config.token;
  if (!token) throw new Error("Sign in first: trinity login USER");
  return { config, client: new FlowerClient<typeof app>(config.url, { credentials: { token } }) };
}

async function mint(claims: TokenClaims, seconds: number): Promise<string> {
  const key = await loadSigningKey(env.TRINITY_AUTH_KEY ?? join(root, ".dev", "auth.pem"));
  return signToken(key, claims, seconds);
}

/** Workers renew their own tokens when they hold the signing key. FLOWER_PARTITION serves one named partition. */
async function workerClient(fetch?: FlowerFetch, role: "worker" | "service" = "worker"): Promise<Client> {
  const partition = env.FLOWER_PARTITION;
  const claims: TokenClaims = { sub: `${role}:${process.pid}`, role, ...(partition ? { tenant: partition } : {}) };
  let current = env.TRINITY_TOKEN ? { token: env.TRINITY_TOKEN, until: Infinity } : { token: await mint(claims, 3_600), until: Date.now() + 1_800_000 };
  const client = new FlowerClient<typeof app>(env.FLOWER_URL ?? "http://127.0.0.1:7101", {
    ...(fetch ? { fetch } : {}),
    credentials: async () => {
      if (current.until < Date.now()) current = { token: await mint(claims, 3_600), until: Date.now() + 1_800_000 };
      return { token: current.token };
    },
  });
  return partition ? client.partition(partition) : client;
}

const blobs = () => (env.TRINITY_BLOBS ? blobStoreFromEnv() : undefined);
const log = (event: unknown) => console.error(JSON.stringify(event));

function untilSignal(): AbortSignal {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  return stop.signal;
}

function parse(args: string[], required: number, options: ParseArgsOptionsConfig = {}) {
  const parsed = parseArgs({ args, options, allowPositionals: true });
  if (parsed.positionals.length < required) {
    console.error(USAGE);
    process.exit(2);
  }
  return { words: parsed.positionals, flags: parsed.values as Record<string, string | boolean | string[] | undefined> };
}

const text = (flag: unknown) => (typeof flag === "string" ? flag : undefined);

// Watching a session

function print(event: Event, streamed: string): void {
  const body = event.body;
  switch (body.type) {
    case "user": {
      const files = body.attachments.length ? ` [${body.attachments.map((each) => each.name).join(", ")}]` : "";
      return console.log(styleText("cyan", `> ${body.text}${files}`));
    }
    case "assistant": {
      const reply = body.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n");
      if (reply !== "") console.log(reply.startsWith(streamed) ? reply.slice(streamed.length) : `\n${reply}`);
      for (const block of body.blocks) {
        if (block.type === "tool_call") console.log(styleText("yellow", `→ ${block.name} ${JSON.stringify(block.input)} [${block.id}]`));
        if (block.type === "provider") console.log(styleText("dim", `(${(block.block as { type?: string }).type ?? "provider block"})`));
      }
      if (body.interrupted) console.log(styleText("dim", "(interrupted)"));
      return;
    }
    case "tool_result":
    case "background_result": {
      const preview = body.content.length > 400 ? `${body.content.slice(0, 400)}…` : body.content;
      const label = body.type === "background_result" ? "background " : "";
      return console.log(styleText(body.isError ? "red" : "dim", `← ${label}[${body.call}] ${preview}`));
    }
    case "tool_awaiting": {
      const how = body.kind === "permission" ? `trinity approve|deny ${event.session} ${body.call}` : `trinity answer ${event.session} ${body.call} …`;
      return console.log(styleText("magenta", `? ${body.prompt}\n  ${how}`));
    }
    case "tool_resolved": return console.log(styleText("dim", `[${body.call} ${body.resolution}]`));
    case "tool_reviewed": return console.log(styleText("dim", `[${body.call} ${body.approved ? `approved by ${body.reviewer}` : `not approved: ${body.note ?? `${body.reviewer} was not sure`}`}]`));
    case "subagent": return console.log(styleText("dim", `[subagent ${body.session} for ${body.call}; trinity watch ${body.session}]`));
    case "compact": return console.log(styleText("dim", `[context summarized: ${body.summary.length} characters]`));
    case "error": return console.log(styleText("red", `! ${body.code}: ${body.message}${body.retryInMs === null ? "" : ` (retrying in ${body.retryInMs} ms)`}`));
    case "status": return console.log(styleText("dim", `[${body.status}]`));
    case "interrupted": return console.log(styleText("dim", "[interrupted by the user]"));
    case "title": return console.log(styleText("bold", `# ${body.title}`));
  }
}

async function watch(client: Client, session: string, signal: AbortSignal): Promise<void> {
  const pageSize = 200;
  let seen = 0;
  let streamed = "";
  while (!signal.aborted) {
    let pageFilled = false;
    for await (const { value } of client.subscribe("session.tail", { session, after: seen, limit: pageSize }, { signal })) {
      if (value === null) throw new Error(`No session ${session}`);
      for (const event of value.events.filter((each) => each.seq > seen)) {
        print(event, streamed);
        if (event.body.type === "assistant") streamed = "";
        seen = event.seq;
      }
      const partial = (value.partial?.deltas ?? []).flatMap((delta) => delta.type === "text" ? [delta.text] : []).join("");
      if (partial.startsWith(streamed) && partial.length > streamed.length) {
        process.stdout.write(partial.slice(streamed.length));
        streamed = partial;
      }
      // Each page holds a bounded number of events; continue from the newest one.
      if (value.events.length === pageSize) {
        pageFilled = true;
        break;
      }
    }
    if (!pageFilled) return;
  }
}

// Commands

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async login(args) {
    const { words: [user], flags } = parse(args, 1, { org: { type: "string" } });
    const config = await readConfig();
    const token = await gateway(config, "/auth/dev", { subject: user, ...(text(flags.org) ? { org: flags.org } : {}) }, null);
    await saveConfig({ ...config, token });
    console.log(`Signed in as ${user}${flags.org ? ` in ${flags.org}` : ""}.`);
  },

  async org([action, ...args]) {
    const { client, config } = await signedIn();
    if (action === "list") {
      for (const org of (await client.query("org.mine")).value) console.log(`${org.id}\t${org.role}\t${org.name}`);
      return;
    }
    if (action !== "create" && action !== "use") return usage();
    const { words: [id, ...name] } = parse(args, 1);
    if (action === "create") await client.mutate("org.create", { id: id!, name: name.join(" ") || id! }, { requestId: `org:${id}`, retry: true });
    await saveConfig({ ...config, token: await gateway(config, "/auth/switch", { org: id }) });
    console.log(`Using ${id}.`);
  },

  async new(args) {
    const { flags } = parse(args, 0, { model: { type: "string" }, computer: { type: "string" }, private: { type: "boolean" } });
    const { client } = await signedIn();
    const id = randomUUID();
    await client.mutate("session.create", {
      id,
      ...(text(flags.model) ? { model: text(flags.model)! } : {}),
      ...(text(flags.computer) ? { computer: text(flags.computer)! } : {}),
      ...(flags.private === true ? { private: true } : {}),
    }, { requestId: `create:${id}`, retry: true });
    console.log(id);
  },

  async list() {
    const { client } = await signedIn();
    for (const session of (await client.query("session.list", {})).value) console.log(`${session.id}\t${session.status}\t${session.title ?? ""}`);
  },

  async send(args) {
    const { words: [session, ...message], flags } = parse(args, 2, { steer: { type: "boolean" } });
    const { client } = await signedIn();
    const id = randomUUID();
    const { value } = await client.mutate("session.send", { session: session!, message: id, text: message.join(" "), steer: flags.steer === true }, { requestId: id, retry: true });
    console.log(value.status);
  },

  approve: (args) => decide(args, true),
  deny: (args) => decide(args, false),

  async answer(args) {
    const { words: [session, call, ...answer] } = parse(args, 3);
    const { client } = await signedIn();
    await client.mutate("session.resolve", { session: session!, call: call!, answer: answer.join(" ") }, { retry: true });
  },

  async halt(args) {
    const { words: [session], flags } = parse(args, 1, { background: { type: "boolean" } });
    const { client } = await signedIn();
    const { value } = await client.mutate("session.halt", { session: session!, background: flags.background === true }, { retry: true });
    console.log(value.halted ? "halted" : `nothing to halt (${value.status})`);
  },

  async watch(args) {
    const { words: [session] } = parse(args, 1);
    const { client } = await signedIn();
    await watch(client, session!, untilSignal());
  },

  async computer([action, ...args]) {
    if (action !== "register") return usage();
    const { words: [id, ...name] } = parse(args, 1);
    const { client, config } = await signedIn();
    await client.mutate("computer.register", { id: id!, name: name.join(" ") || id! }, { retry: true });
    const token = await gateway(config, "/auth/computer", { computer: id });
    await saveConfig({ ...config, computers: { ...config.computers, [id!]: token } });
    console.log(`Registered ${id}. Run its tools with: trinity local --computer ${id} --workspace DIR`);
  },

  async local(args) {
    const { flags } = parse(args, 0, { computer: { type: "string" }, workspace: { type: "string" }, lanes: { type: "string" } });
    const computer = text(flags.computer);
    if (computer === undefined) throw new Error("--computer is required");
    const config = await readConfig();
    const token = env.TRINITY_TOKEN ?? config.computers[computer];
    if (!token) throw new Error(`Register this computer first: trinity computer register ${computer}`);
    const store = blobs();
    await runLocalWorker(new FlowerClient<typeof app>(config.url, { credentials: { token } }), {
      signal: untilSignal(),
      computer,
      workspace: text(flags.workspace) ?? process.cwd(),
      ...(store ? { blobs: store } : {}),
      ...(text(flags.lanes) ? { lanes: Number(flags.lanes) } : {}),
      onEvent: (event) => log(event.type === "claimed" ? { type: event.type, id: event.job.id } : event),
    });
  },

  async mcp([action, ...args]) {
    const { client } = await signedIn();
    if (action === "list") {
      for (const server of (await client.query("mcp.list")).value) {
        console.log(`${server.name}\t${server.url}\t${server.enabled ? "enabled" : "disabled"}\t${server.tools?.join(",") ?? "(catalog pending)"}`);
      }
      return;
    }
    if (action !== "add") return usage();
    const { words: [name, url], flags } = parse(args, 2, { header: { type: "string", multiple: true }, trusted: { type: "boolean" } });
    const headers = Object.fromEntries(((flags.header as string[] | undefined) ?? []).map((entry) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)];
    }));
    await client.mutate("mcp.set", { name: name!, url: url!, headers, trusted: flags.trusted === true }, { retry: true });
    console.log(`Added ${name}. Its tools appear once the service has read its catalog.`);
  },

  async llm(args) {
    const { flags } = parse(args, 0, { lanes: { type: "string" } });
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      console.error("No ANTHROPIC_API_KEY in the environment: unless an `ant auth login` profile exists, completions will fail. Add the key to .env.local and restart.");
    }
    const store = blobs();
    await runLlmWorker(await workerClient(), new Anthropic(), {
      signal: untilSignal(),
      ...(store ? { blobs: store } : {}),
      ...(text(flags.lanes) ? { lanes: Number(flags.lanes) } : {}),
      onEvent: (event) => log(event.type === "claimed" ? { type: event.type, id: event.job.id } : event),
    });
  },

  async sim(args) {
    const { flags } = parse(args, 0, Object.fromEntries(
      ["speedup", "stops", "max-stops", "computers", "concurrency", "tool-concurrency", "claimers", "flush-ms", "connections"].map((name) => [name, { type: "string" }]),
    ) as ParseArgsOptionsConfig);
    const number = (name: string, fallback: number) => (text(flags[name]) === undefined ? fallback : Number(flags[name]));
    // Thousands of jobs in flight outgrow one connection's stream limit.
    const connections = http2Connections(number("connections", 24));
    const rate = (count: number, seconds: number) => Math.round(count / seconds).toLocaleString("en-US");
    try {
      await runSim(await workerClient(connections.fetch), {
        signal: untilSignal(),
        profile: {
          speedup: number("speedup", DEFAULT_PROFILE.speedup),
          stops: number("stops", DEFAULT_PROFILE.stops),
          maxStops: number("max-stops", DEFAULT_PROFILE.maxStops),
        },
        computers: number("computers", 16),
        concurrency: number("concurrency", 2_048),
        toolConcurrency: number("tool-concurrency", 2_048),
        claimers: number("claimers", 64),
        ...(text(flags["flush-ms"]) ? { flushMs: Number(flags["flush-ms"]) } : {}),
        onStats: (stats) => console.error(
          `sim: ${rate(stats.completions, stats.seconds)} completions/s, ${rate(stats.tools, stats.seconds)} tool calls/s, ` +
          `${rate(stats.flushes, stats.seconds)} flushes/s, ${stats.inFlight} completions in flight, ${stats.lost} lost, ${stats.failed} failed`,
        ),
      });
    } finally {
      await connections.close();
    }
  },

  async slack([action, ...args]) {
    if (action === "setup") {
      const { flags } = parse(args, 0, { name: { type: "string" }, "config-token": { type: "string" } });
      const { config } = await signedIn();
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        await setupSlack({
          name: text(flags.name) ?? "Trinity",
          envFile: join(root, ".env.local"),
          env,
          publicUrl: env.TRINITY_PUBLIC_URL,
          configToken: text(flags["config-token"]),
          connect: (token) => postGateway(config, "/slack/connect", { token }),
          install: async () => (await postGateway<{ url: string }>(config, "/slack/install", {})).url,
          ask: (question) => prompt.question(question),
          say: (line) => console.log(line),
        });
      } finally {
        prompt.close();
      }
      return;
    }
    if (action === "status") {
      const { client } = await signedIn();
      const { value } = await client.query("slack.status");
      if (value.workspaces.length === 0) console.log("No Slack workspace is connected. Run: trinity slack setup");
      for (const workspace of value.workspaces) console.log(`${workspace.team}\t${workspace.name}\t${workspace.url}`);
      for (const link of value.linked) console.log(`you are ${link.user} in ${link.team}`);
      return;
    }
    if (action !== undefined) return usage();
    // Setup writes the app token to .env.local; wait for it, so a running dev stack needs no restart.
    const signal = untilSignal();
    for (let told = false; !env.SLACK_APP_TOKEN && !signal.aborted; await delay(5_000, undefined, { signal }).catch(() => {})) {
      try {
        process.loadEnvFile(join(root, ".env.local"));
      } catch {}
      if (!env.SLACK_APP_TOKEN && !told) {
        console.error("Slack is not set up yet: run `trinity slack setup`. Waiting for SLACK_APP_TOKEN in .env.local…");
        told = true;
      }
    }
    if (signal.aborted) return;
    const store = blobs();
    await runSlack({ service: await workerClient(undefined, "service"), worker: await workerClient() }, {
      signal,
      appToken: env.SLACK_APP_TOKEN!,
      signingKey: await loadSigningKey(env.TRINITY_AUTH_KEY ?? join(root, ".dev", "auth.pem")),
      log,
      ...(store ? { blobs: store } : {}),
      ...(env.TRINITY_PUBLIC_URL ? { publicUrl: env.TRINITY_PUBLIC_URL } : {}),
    });
  },

  async service() {
    const store = blobs();
    const secrets = envSecrets();
    const typesafe = secrets("typesafe_key");
    await runService(await workerClient(), {
      signal: untilSignal(),
      secrets,
      // The simulation names sessions and reviews calls itself.
      ...(env.TRINITY_SIM ? { loops: ["tools", "sealing", "catalog", "github", "billing"] } : { anthropic: new Anthropic() }),
      ...(typesafe ? { jev: { apiKey: typesafe } } : {}),
      log,
      ...(store ? { blobs: store } : {}),
      ...(env.TRINITY_PUBLIC_URL ? { publicUrl: env.TRINITY_PUBLIC_URL } : {}),
    });
  },

  async sandboxes() {
    const store = blobs();
    await runSandboxes(await workerClient(), { signal: untilSignal(), ...(store ? { blobs: store } : {}), onEvent: log });
  },

  async token(args) {
    const { flags } = parse(args, 0, { role: { type: "string" }, sub: { type: "string" }, ttl: { type: "string" } });
    const role = flags.role;
    if (role !== "worker" && role !== "service") throw new Error("--role must be worker or service");
    console.log(await mint({ sub: text(flags.sub) ?? role, role }, Number(flags.ttl ?? 86_400)));
  },
};

async function decide(args: string[], approve: boolean): Promise<void> {
  const { words: [session, call], flags } = parse(args, 2, { always: { type: "boolean" } });
  const { client } = await signedIn();
  await client.mutate("session.resolve", { session: session!, call: call!, approve, always: flags.always === true }, { retry: true });
}

async function usage(): Promise<void> {
  console.error(USAGE);
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
const run = command === undefined ? undefined : commands[command];
if (run === undefined) {
  console.error(USAGE);
  process.exit(command === undefined || command === "help" ? 0 : 2);
}
await run(args);
