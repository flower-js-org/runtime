import { define, jwtBearer, type Authenticate, type Authenticator } from "@flower-js/sdk";
import { scopeAccess, TOKEN_AUDIENCE, TOKEN_ISSUER, workerAccess } from "./access.ts";
import { deleteAutomation, listAutomationsMethod, runAutomationNow, setAutomation } from "./automations.ts";
import {
  claimProvision, completeProvision, createSandbox, failProvision, heartbeat, listComputers, registerComputer, removeComputer, runningSandboxes,
} from "./computers.ts";
import {
  claimCompletion, claimTool, completeCompletion, completeTool, failCompletionMethod, failTool, progressCompletion,
} from "./jobs.ts";
import { deleteMemory, listMemory, readMemory, writeMemory } from "./memories.ts";
import { createOrg, getOrg, listMcp, listMembers, myOrgs, orgUsage, removeMcp, removeMember, setMcp, setMember, updateOrg } from "./orgs.ts";
import { completeSeal, readEvents } from "./sealing.ts";
import {
  haltSlack, installSlack, linkSlack, receiveSlack, resolveSlack, slackInstallations, slackPosted, slackStatus, slackWhois, uninstallSlack, unlinkSlack,
} from "./slack.ts";
import { archive, blobAccess, configure, create, get, halt, list, prompt, resolve, send, tail } from "./sessions.ts";
import {
  automations, billing, blobRefs, completions, computers, events, mcpCatalog, mcpServers, members, memories, outbound, partials, provision,
  sealing, segments, sessions, slackInstalls, slackLinks, slackMessages, spend, titles, toolJobs, usage,
} from "./store.ts";
import { receiveSurface } from "./surfaces.ts";
import { timers } from "./timers.ts";

export interface AppOptions {
  /**
   * Verifies callers' credentials. Deployments pass `jwtBearer` with the gateway's public
   * key; tests pass a stand-in, since the in-process engine has no native crypto.
   */
  readonly authenticate: Authenticate | Authenticator | null;
}

const forWorkers = { access: workerAccess };

export function makeApp(options: AppOptions) {
  return define({
    uses: [completions, toolJobs, outbound, provision, billing, sealing, timers, titles, mcpCatalog],
    collections: [
      sessions, events, partials, segments, members, usage, mcpServers, computers, automations, memories, blobRefs,
      slackInstalls, slackLinks, slackMessages,
    ],
    definitions: [spend],
    ...(options.authenticate === null ? {} : { auth: { authenticate: options.authenticate } }),
    http: {
      // Organizations
      "org.create": createOrg,
      "org.mine": myOrgs,
      "org.get": getOrg,
      "org.update": updateOrg,
      "org.members": listMembers,
      "org.setMember": setMember,
      "org.removeMember": removeMember,
      "org.usage": orgUsage,
      "mcp.list": listMcp,
      "mcp.set": setMcp,
      "mcp.remove": removeMcp,

      // Sessions
      "session.create": create,
      "session.send": send,
      "session.resolve": resolve,
      "session.halt": halt,
      "session.configure": configure,
      "session.archive": archive,
      "session.get": get,
      "session.list": list,
      "session.tail": tail,
      "session.blob": blobAccess,

      // Memory, automations and computers
      "memory.list": listMemory,
      "memory.read": readMemory,
      "memory.write": writeMemory,
      "memory.delete": deleteMemory,
      "automation.set": setAutomation,
      "automation.delete": deleteAutomation,
      "automation.list": listAutomationsMethod,
      "automation.run": runAutomationNow,
      "computer.register": registerComputer,
      "computer.createSandbox": createSandbox,
      "computer.remove": removeComputer,
      "computer.list": listComputers,
      "computer.heartbeat": heartbeat,

      // Slack
      "slack.status": slackStatus,
      "slack.unlink": unlinkSlack,
      "slack.uninstall": uninstallSlack,

      // The gateway and the Slack worker
      "surface.receive": receiveSurface,
      "slack.install": installSlack,
      "slack.link": linkSlack,
      "slack.whois": slackWhois,
      "slack.receive": receiveSlack,
      "slack.halt": haltSlack,
      "slack.resolve": resolveSlack,

      // Workers
      "session.prompt": prompt,
      "session.events": readEvents,
      "slack.installations": slackInstallations,
      "slack.posted": slackPosted,
      "computer.running": runningSandboxes,
      "completions.claim": claimCompletion,
      "completions.complete": completeCompletion,
      "completions.fail": failCompletionMethod,
      "completions.progress": progressCompletion,
      ...completions.http("completions", { methods: ["renew", "ready", "stats", "get"], ...forWorkers }),
      "tools.claim": claimTool,
      "tools.complete": completeTool,
      "tools.fail": failTool,
      ...toolJobs.http("tools", { scope: "argument", methods: ["renew", "ready", "stats", "get"], access: scopeAccess }),
      "provision.claim": claimProvision,
      "provision.complete": completeProvision,
      "provision.fail": failProvision,
      ...provision.http("provision", { methods: ["renew", "ready", "stats"], ...forWorkers }),
      "sealing.complete": completeSeal,
      ...sealing.http("sealing", { methods: ["claim", "renew", "fail", "ready", "stats"], ...forWorkers }),
      ...outbound.http("outbound", { scope: "argument", ...forWorkers }),
      ...billing.http("billing", forWorkers),
      ...titles.http("titles", forWorkers),
      ...mcpCatalog.http("mcp.catalog", forWorkers),
    },
  });
}

/** The deployed application: callers present tokens signed by the gateway's key. */
export function makeDeployedApp(publicKeyPem: string) {
  return makeApp({ authenticate: jwtBearer({ key: publicKeyPem, algorithms: ["EdDSA"], issuer: TOKEN_ISSUER, audience: [TOKEN_AUDIENCE] }) });
}
