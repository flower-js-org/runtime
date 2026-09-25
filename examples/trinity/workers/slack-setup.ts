import { readFile, writeFile } from "node:fs/promises";
import { slackCall, SlackError } from "./slack.ts";

// Registering Trinity's Slack app: its manifest, and the guided setup behind
// `trinity slack setup`. Slack's manifest API creates the app from a configuration token;
// two steps stay manual because Slack only offers them in its settings pages: issuing the
// app-level token Socket Mode connects with, and (without an https address for OAuth)
// installing the app into a workspace.

export const BOT_SCOPES = [
  "app_mentions:read", "channels:history", "channels:read", "chat:write", "files:read", "groups:history", "groups:read",
  "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "reactions:read", "reactions:write", "users:read",
];

export const BOT_EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim", "reaction_added", "app_home_opened"];

/** Bot users go by a lowercase handle. */
export const botHandle = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "trinity";

/** The app as Slack's manifest API takes it. Socket Mode needs no request URLs; OAuth needs an https redirect. */
export function slackManifest(options: { name: string; publicUrl?: string | undefined }) {
  const base = options.publicUrl?.startsWith("https://") ? options.publicUrl.replace(/\/$/, "") : null;
  return {
    display_information: { name: options.name, description: "An agent that works in your threads.", background_color: "#1b1f24" },
    features: {
      app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: botHandle(options.name), always_online: true },
    },
    oauth_config: { ...(base === null ? {} : { redirect_urls: [`${base}/slack/oauth`] }), scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: BOT_EVENTS },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

export interface SetupOptions {
  readonly name: string;
  /** Where the app's credentials are kept: the dev stack's .env.local. */
  readonly envFile: string;
  readonly env: Record<string, string | undefined>;
  readonly publicUrl?: string | undefined;
  readonly configToken?: string | undefined;
  /** Hand a bot token to the gateway, which seals it and connects its workspace to the signed-in organization. */
  readonly connect: (botToken: string) => Promise<{ name: string; org: string }>;
  /** Ask the gateway for Slack's OAuth page, where an admin installs the app (deployments with an https address). */
  readonly install: () => Promise<string>;
  readonly ask: (question: string) => Promise<string>;
  readonly say: (line: string) => void;
  readonly call?: typeof slackCall;
}

/** Create (or update) the app, collect its app-level token, and connect a workspace. Safe to run again. */
export async function setupSlack(options: SetupOptions): Promise<void> {
  const call = options.call ?? slackCall;
  const { env, say } = options;
  const accepts = async (appToken: string) => {
    try {
      await call(appToken, "apps.connections.open");
      return true;
    } catch (error) {
      if (error instanceof SlackError && !error.retryable) return false;
      throw error;
    }
  };

  const configToken = options.configToken ?? env.SLACK_CONFIG_TOKEN ?? await options.ask(
    "Slack creates apps from a configuration token: at https://api.slack.com/apps, under \"Your App Configuration Tokens\", generate one for your workspace.\nPaste the access token (xoxe.xoxp-…): ",
  );
  const manifest = slackManifest({ name: options.name, publicUrl: options.publicUrl });
  let appId = env.SLACK_APP_ID;
  if (appId !== undefined) {
    await call(configToken.trim(), "apps.manifest.update", { app_id: appId, manifest });
    say(`Updated the Slack app ${appId} from its manifest.`);
  } else {
    const created = await call<{ app_id: string; credentials: { client_id: string; client_secret: string } }>(configToken.trim(), "apps.manifest.create", { manifest });
    appId = created.app_id;
    await upsertEnv(options.envFile, { SLACK_APP_ID: appId, SLACK_CLIENT_ID: created.credentials.client_id, SLACK_CLIENT_SECRET: created.credentials.client_secret });
    say(`Created the Slack app ${appId}; its credentials are in ${options.envFile}.`);
  }
  const settings = `https://api.slack.com/apps/${appId}`;

  if (env.SLACK_APP_TOKEN === undefined || !await accepts(env.SLACK_APP_TOKEN)) {
    say(`\nSocket Mode connects with an app-level token, which only Slack's settings page issues:\n  ${settings}/general → App-Level Tokens → Generate Token and Scopes → add connections:write → Generate`);
    const appToken = (await options.ask("Paste the token (xapp-…): ")).trim();
    if (!await accepts(appToken)) throw new Error("Slack did not accept that app-level token");
    await upsertEnv(options.envFile, { SLACK_APP_TOKEN: appToken });
  }

  if (options.publicUrl?.startsWith("https://")) {
    say(`\nInstall the app into a workspace here (the link is good for ten minutes):\n  ${await options.install()}`);
  } else {
    say(`\nInstall the app into your workspace: ${settings}/install-on-team → Install to Workspace → Allow, then copy the Bot User OAuth Token.`);
    const botToken = (await options.ask("Paste the bot token (xoxb-…): ")).trim();
    const connected = await options.connect(botToken);
    say(`Connected the ${connected.name} workspace to ${connected.org}.`);
  }
  say(`\nDone. The Slack worker starts once SLACK_APP_TOKEN is in ${options.envFile} (the dev stack's slack process picks it up; elsewhere run \`trinity slack\`). Invite @${botHandle(options.name)} to a channel and mention it, or send it a direct message.`);
}

/** Set variables in a dotenv file, keeping everything else in it. */
export async function upsertEnv(path: string, values: Record<string, string>): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await readFile(path, "utf8")).split("\n");
  } catch {}
  if (lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`) || line.startsWith(`export ${key}=`));
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}
