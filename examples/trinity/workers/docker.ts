import { spawn } from "node:child_process";
import { posix } from "node:path";
import type { ToolJob, ToolOutcome } from "../app/model.ts";
import { directoryListing, lineRange, truncate } from "./outputs.ts";

const WORKSPACE = "/workspace";
const LABEL = "trinity.computer";

export interface DockerComputer { id: string; image: string }

export interface DockerOptions {
  /** The Docker CLI. Default "docker". */
  readonly docker?: string;
}

export interface DockerProviderOptions extends DockerOptions {
  /** The network containers join. Docker's default bridge when absent. */
  readonly network?: string;
}

/** Sandboxes for computer tools: one long-lived container per computer, holding its workspace. */
export class DockerProvider {
  private readonly docker: string;
  private readonly network: string | undefined;

  constructor(options: DockerProviderOptions = {}) {
    this.docker = options.docker ?? "docker";
    this.network = options.network;
  }

  /** Start the computer's container, creating it if needed; an existing one keeps its image and workspace. */
  async start(computer: DockerComputer, signal?: AbortSignal): Promise<{ container: string }> {
    const container = containerName(computer.id);
    let state = await this.state(container, signal);
    if (state === undefined) {
      const network = this.network === undefined ? [] : ["--network", this.network];
      // An init process reaps what commands leave behind; `sleep` as PID 1 would not.
      const created = await run(this.docker, [
        "run", "--detach", "--init", "--name", container, "--label", `${LABEL}=${computer.id}`,
        ...network, "--workdir", WORKSPACE, computer.image, "sleep", "infinity",
      ], signal);
      // Losing a race with a concurrent start leaves the other's container.
      state = created.code === 0 ? "running" : await this.state(container, signal);
      if (state === undefined) throw failure("run", created);
    }
    if (state === "paused") await this.check(["unpause", container], signal);
    else if (state !== "running") await this.check(["start", container], signal);
    await this.check(["exec", container, "mkdir", "-p", WORKSPACE], signal);
    return { container };
  }

  async stop(id: string, signal?: AbortSignal): Promise<void> {
    const result = await run(this.docker, ["rm", "--force", "--volumes", containerName(id)], signal);
    if (result.code !== 0 && !missing(result)) throw failure("rm", result);
  }

  async status(id: string, signal?: AbortSignal): Promise<"running" | "stopped" | "missing"> {
    const state = await this.state(containerName(id), signal);
    return state === undefined ? "missing" : state === "running" ? "running" : "stopped";
  }

  /** Docker's state for the container (running, exited, paused…), or undefined when there is none. */
  private async state(container: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await run(this.docker, ["container", "inspect", "--format", "{{.State.Status}}", container], signal);
    if (result.code === 0) return result.stdout.toString("utf8").trim();
    if (missing(result)) return undefined;
    throw failure("container inspect", result);
  }

  private async check(args: string[], signal?: AbortSignal): Promise<void> {
    const result = await run(this.docker, args, signal);
    if (result.code !== 0) throw failure(args[0]!, result);
  }
}

function containerName(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) throw new Error(`${id} cannot name a container`);
  return `trinity-${id}`;
}

/**
 * Run a tool job in a container started by DockerProvider, with the tools and output formats of the local computer.
 * Tool failures become error results for the model; only an abort propagates.
 */
export async function executeInContainer(container: string, job: Pick<ToolJob, "name" | "input">, signal: AbortSignal, options: DockerOptions = {}): Promise<ToolOutcome> {
  const docker = options.docker ?? "docker";
  const input = job.input as Record<string, any>;
  try {
    switch (job.name) {
      case "list_files": return listFiles(await inWorkspace(docker, container, LIST, input.path ?? ".", signal));
      case "read_file": return readText(await inWorkspace(docker, container, READ, input.path, signal), input.offset, input.limit);
      case "write_file": {
        await inWorkspace(docker, container, WRITE, input.path, signal, input.content);
        return { content: `Wrote ${input.content.length} characters to ${input.path}.`, isError: false };
      }
      case "bash": return await bash(docker, container, input.command, input.timeoutMs ?? 120_000, signal);
      default: return { content: `This computer cannot run ${job.name}.`, isError: true };
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
}

// Scripts get the workspace as $1 and the lexically resolved target as $2; user input only ever travels in argv or stdin.
const OUTSIDE = 90;
const MISSING = 91;
const DIRECTORY = 92;
const NOT_DIRECTORY = 93;

// Resolve symlinks as far as the path exists, as the local computer does, and refuse anything outside the workspace.
const CONFINE = `r=$(realpath -m -- "$1") && p=$(realpath -m -- "$2") || exit 1
case $p in "$r"|"$r"/*) ;; *) exit ${OUTSIDE} ;; esac
`;

// NUL-separated names; like readdir's Dirent, a symlink to a directory is not a directory.
const LIST = `${CONFINE}[ -e "$p" ] || exit ${MISSING}
[ -d "$p" ] || exit ${NOT_DIRECTORY}
cd -- "$p" || exit 1
for e in * .[!.]* ..?*; do
  if [ -d "$e" ] && [ ! -L "$e" ]; then printf '%s/\\0' "$e"
  elif [ -e "$e" ] || [ -L "$e" ]; then printf '%s\\0' "$e"
  fi
done
`;

const READ = `${CONFINE}[ -e "$p" ] || exit ${MISSING}
[ -d "$p" ] && exit ${DIRECTORY}
exec cat -- "$p"
`;

const WRITE = `${CONFINE}[ -d "$p" ] && exit ${DIRECTORY}
mkdir -p -- "$(dirname -- "$p")" && exec cat > "$p"
`;

async function inWorkspace(docker: string, container: string, script: string, path: string, signal: AbortSignal, input?: string): Promise<Buffer> {
  const target = posix.resolve(WORKSPACE, path);
  const stdin = input === undefined ? [] : ["--interactive"];
  const result = await run(docker, ["exec", ...stdin, container, "sh", "-c", script, "sh", WORKSPACE, target], signal, input);
  switch (result.code) {
    case 0: return result.stdout;
    case OUTSIDE: throw new Error(`${path} is outside the workspace`);
    case MISSING: throw new Error(`${path} does not exist`);
    case DIRECTORY: throw new Error(`${path} is a directory`);
    case NOT_DIRECTORY: throw new Error(`${path} is not a directory`);
    default: throw new Error(result.stderr.trim() || `exit ${result.code}`);
  }
}

function listFiles(stdout: Buffer): ToolOutcome {
  return directoryListing(stdout.toString("utf8").split("\0").filter(Boolean));
}

function readText(stdout: Buffer, offset?: number, limit?: number): ToolOutcome {
  return lineRange(stdout.toString("utf8"), offset, limit);
}

// Prints its PID, which GNU timeout keeps and makes a process group ID, so the whole command can be killed from outside.
// The in-container timeout is only a backstop for when the worker dies; the worker's own timer reports timeouts.
const BASH = `echo "$$"; exec timeout -k 5 "$1" bash -c "$2"`;
const BACKSTOP_S = 10;
// Killing the docker CLI leaves the command running, so stopping signals the group inside the container.
const KILL = `kill -TERM -"$1" 2>/dev/null || kill -TERM "$1" 2>/dev/null || exit 0
i=0
while [ "$i" -lt 20 ] && kill -0 -"$1" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
kill -KILL -"$1" 2>/dev/null
exit 0
`;
// How long the docker CLI may outlive a stop, e.g. while an escaped background process holds its output open.
const STOP_GRACE_MS = 5_000;

function bash(docker: string, container: string, command: string, timeoutMs: number, signal: AbortSignal): Promise<ToolOutcome> {
  signal.throwIfAborted();
  return new Promise((done, reject) => {
    const backstop = `${Math.ceil(timeoutMs / 1_000) + BACKSTOP_S}s`;
    const child = spawn(docker, ["exec", "--workdir", WORKSPACE, container, "sh", "-c", BASH, "sh", backstop, command], { stdio: ["ignore", "pipe", "pipe"] });
    let pid: string | undefined;
    let head = "";
    let output = "";
    let timedOut = false;
    let stopping = false;
    let killing: Promise<void> | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      force = setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS);
      if (pid !== undefined) killing = kill(docker, container, pid);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (pid !== undefined) { output += chunk; return; }
      head += chunk;
      const newline = head.indexOf("\n");
      if (newline < 0) return;
      pid = head.slice(0, newline);
      output += head.slice(newline + 1);
      if (stopping) killing = kill(docker, container, pid);
    });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    let settled = false;
    const settle = async (outcome: () => ToolOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      // Report only once nothing the command started is left running.
      await killing;
      if (signal.aborted) reject(signal.reason);
      else done(outcome());
    };
    child.on("error", (error) => settle(() => ({ content: error.message, isError: true })));
    child.on("close", (code) => settle(() => {
      // The command never started, e.g. the container is gone: report docker's error.
      if (pid === undefined) return { content: (head + output).trim() || `exit ${code}`, isError: true };
      const status = timedOut ? `timed out after ${timeoutMs} ms` : `exit ${code}`;
      return { content: `${status}\n${truncate(output)}`.trimEnd(), isError: timedOut || code !== 0 };
    }));
  });
}

function kill(docker: string, container: string, pid: string): Promise<void> {
  return new Promise((done) => {
    const child = spawn(docker, ["exec", container, "sh", "-c", KILL, "sh", pid], { stdio: "ignore", timeout: 15_000 });
    child.on("error", () => done());
    child.on("close", () => done());
  });
}

interface Result { code: number | null; stdout: Buffer; stderr: string }

function run(docker: string, args: string[], signal?: AbortSignal, input?: string): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(docker, args, { signal, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => signal?.aborted ? reject(signal.reason) : done({ code, stdout: Buffer.concat(stdout), stderr }));
    // The script may exit before reading its input, e.g. when it refuses the path.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function missing(result: Result): boolean {
  return /no such (container|object)/i.test(result.stderr);
}

function failure(command: string, result: Result): Error {
  return new Error(`docker ${command} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
}
