import { fail, type MutationContext } from "@flower-js/sdk";
import { clone, type Session } from "./model.ts";
import { settingsOf } from "./orgs.ts";
import { orgs, sessions } from "./store.ts";

/** Request overhead beyond the log (system prompt, tools), for estimating a request's size. */
export const BASE_TOKENS = 4_000;

/**
 * The sessions one mutation reads and changes. A subagent's answer, a halt that reaches
 * child sessions, or a surface message can touch several; each is loaded once and all are
 * saved together by `commit`.
 */
export class Tx {
  readonly ctx: MutationContext;
  private readonly loaded = new Map<string, Session>();

  constructor(ctx: MutationContext) {
    this.ctx = ctx;
  }

  find(id: string): Session | null {
    const cached = this.loaded.get(id);
    if (cached !== undefined) return cached;
    const row = this.ctx.get(sessions, id);
    if (row === null) return null;
    const session = clone(row);
    this.loaded.set(id, session);
    return session;
  }

  load(id: string): Session {
    return this.find(id) ?? fail("SESSION_NOT_FOUND", `No session ${id}`);
  }

  add(session: Session): void {
    this.loaded.set(session.id, session);
  }

  commit(): void {
    const now = this.ctx.now();
    for (const session of this.loaded.values()) {
      session.updatedAt = now;
      this.ctx.set(sessions, session.id, session);
    }
  }
}

type Configurable = "model" | "system" | "computer" | "private" | "parent" | "source" | "allow" | "autoApprove" | "webTools" | "graceMs" | "contextTokens";
export type SessionInit = Pick<Session, "id" | "org" | "createdBy"> & Partial<Pick<Session, Configurable>>;

/** A new idle session, with the organization's defaults for whatever `init` leaves out. */
export function newSession(tx: Tx, init: SessionInit): Session {
  const org = tx.ctx.get(orgs, init.org) ?? fail("ORG_NOT_FOUND", `No organization ${init.org}`);
  const settings = settingsOf(org);
  const now = tx.ctx.now();
  const session: Session = {
    id: init.id,
    org: init.org,
    createdBy: init.createdBy,
    createdAt: now,
    updatedAt: now,
    title: null,
    model: init.model ?? settings.model,
    system: init.system ?? null,
    computer: init.computer ?? null,
    private: init.private ?? false,
    parent: init.parent ?? null,
    source: init.source ?? null,
    status: "idle",
    seq: 0,
    steps: 0,
    turn: null,
    queued: [],
    allow: init.allow ?? [],
    autoApprove: init.autoApprove ?? settings.autoApprove,
    webTools: init.webTools ?? settings.webTools,
    graceMs: init.graceMs ?? settings.graceMs,
    contextTokens: init.contextTokens ?? settings.contextTokens,
    contextEstimate: BASE_TOKENS,
    compactSeq: 0,
    sealedThrough: 0,
    sealWanted: 0,
    background: {},
    memory: null,
    lastText: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costNanos: 0,
    archived: false,
  };
  tx.add(session);
  return session;
}
