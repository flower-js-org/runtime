// Organization settings, members, MCP servers and Slack workspaces.
import { For, refresh, Show } from "solid-js";
import { client, describe, slackInstallUrl } from "../api.ts";
import { dateTime, dollarsToNanos, nanosToDollars } from "../format.ts";
import { busy, confirmAction, field, load, ModelOptions, openDialog, orgsChanged, submitter, toast } from "../ui.tsx";
import { Loading, Page, Table } from "./Page.tsx";

export const SettingsPage = () => <Page title="Settings"><Settings /></Page>;

type Computer = { id: string; name: string };

export const ComputerOptions = (props: { computers: Computer[]; selected: string | null; empty?: string }) => (
  <>
    <option value="">{props.empty ?? "None"}</option>
    <For each={props.computers}>{(each) => <option value={each.id} selected={each.id === props.selected}>{each.name}</option>}</For>
  </>
);

function Settings() {
  const org = load(() => client().query("org.get", null, { retry: true }), "Loading settings");
  const computers = load(() => client().query("computer.list", null, { retry: true }), "Loading settings");
  const admin = () => org()?.role === "admin";

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    void busy(submitter(event), async () => {
      await client().mutate("org.update", {
        name: field(form, "name").value.trim(),
        settings: {
          model: field(form, "model").value.trim(),
          computer: field(form, "computer").value || null,
          budgetNanos: dollarsToNanos(field(form, "budget").value),
          contextTokens: Number(field(form, "contextTokens").value),
          graceMs: Math.round(Number(field(form, "grace").value) * 1000),
          autoApprove: field(form, "autoApprove").checked,
          autoApproveAt: Number(field(form, "autoApproveAt").value),
          webTools: field(form, "webTools").checked,
        },
      }, { retry: true });
      toast("Settings saved.", "info");
      orgsChanged();
      void refresh(org);
    });
  };

  return (
    <Show when={org() && computers() ? { ...org()!, computers: computers()! } : null} fallback={<Loading />}>
      {(loaded) => (
        <>
          <section class="panel">
            <h2>Organization</h2>
            <Show when={!admin()}><p class="muted">Only admins change these settings.</p></Show>
            <form class="form-grid" onSubmit={save}>
              <fieldset disabled={!admin()}>
                <label>Name<input name="name" value={loaded().org.name} required maxlength="200" /></label>
                <label>ID<input value={loaded().org.id} readonly /></label>
                <label>Default model<input name="model" value={loaded().org.settings.model} list="models" required /></label>
                <ModelOptions />
                <label>Default computer
                  <select name="computer"><ComputerOptions computers={loaded().computers} selected={loaded().org.settings.computer} /></select>
                  <span class="hint">For automations, Slack and GitHub, and sessions that don't choose one.</span>
                </label>
                <label>Monthly budget (USD)
                  <input name="budget" inputmode="decimal" value={nanosToDollars(loaded().org.settings.budgetNanos)} placeholder="No limit" />
                  <span class="hint">New turns stop once this month's spending reaches it.</span>
                </label>
                <label>Context limit (tokens)
                  <input name="contextTokens" type="number" min="10000" max="900000" step="1000" value={loaded().org.settings.contextTokens} required />
                  <span class="hint">Conversations are summarized before a request would exceed this.</span>
                </label>
                <label>Halt grace window (seconds)
                  <input name="grace" type="number" min="0" max="600" step="1" value={loaded().org.settings.graceMs / 1000} required />
                  <span class="hint">How long running tools may finish after a halt.</span>
                </label>
                <label>Auto-approval threshold
                  <input name="autoApproveAt" type="number" min="0" max="1" step="0.01" value={loaded().org.settings.autoApproveAt} required />
                  <span class="hint">How sure Jev must be, from 0 to 1, that a call is safe.</span>
                </label>
                <label class="check"><input type="checkbox" name="autoApprove" checked={loaded().org.settings.autoApprove} /> Auto-approve tool calls that Jev judges safe, in new sessions</label>
                <label class="check"><input type="checkbox" name="webTools" checked={loaded().org.settings.webTools} /> Web search and fetch in new sessions</label>
                <div class="actions"><button type="submit" class="primary">Save settings</button></div>
              </fieldset>
            </form>
          </section>
          <Members admin={admin()} />
          <McpServers admin={admin()} />
          <SlackWorkspaces admin={admin()} />
        </>
      )}
    </Show>
  );
}

function Members(props: { admin: boolean }) {
  const members = load(() => client().query("org.members", null, { retry: true }), "Loading members");
  const setRole = (select: HTMLSelectElement, subject: string) => {
    const role = select.value as "admin" | "member";
    void busy(select, async () => {
      await client().mutate("org.setMember", { subject, role }, { retry: true });
      toast(`${subject} is now ${role === "admin" ? "an admin" : "a member"}.`, "info");
    }, "Changing the role").finally(() => refresh(members));
  };
  const add = (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    void busy(submitter(event), async () => {
      const name = field(form, "name").value.trim();
      await client().mutate("org.setMember", { subject: field(form, "subject").value.trim(), role: field(form, "role").value as "admin" | "member", ...(name ? { name } : {}) }, { retry: true });
      form.reset();
      await refresh(members);
    });
  };
  return (
    <section class="panel">
      <h2>Members</h2>
      <Show when={members()} fallback={<Loading />}>
        {(list) => (
          <Table head={["Member", "Role", "Joined"]}>
            <For each={list()} keyed={(member) => member.subject}>
              {(member) => (
                <tr>
                  <td><div>{member().name ?? member().subject}</div><Show when={member().name}><div class="muted small">{member().subject}</div></Show></td>
                  <td>
                    <Show when={props.admin} fallback={member().role === "admin" ? "Admin" : "Member"}>
                      <label class="sr-only" for={`role-${member().subject}`}>Role of {member().subject}</label>
                      <select id={`role-${member().subject}`} onChange={(event) => setRole(event.currentTarget, member().subject)}>
                        <option value="member" selected={member().role === "member"}>Member</option>
                        <option value="admin" selected={member().role === "admin"}>Admin</option>
                      </select>
                    </Show>
                  </td>
                  <td class="muted">{dateTime(member().joinedAt)}</td>
                  <td class="row-actions">
                    <Show when={props.admin}>
                      <button type="button" class="danger ghost" onClick={() => confirmAction("Remove member?", `${member().subject} loses access to this organization.`, "Remove", async () => {
                        await client().mutate("org.removeMember", { subject: member().subject }, { retry: true });
                        await refresh(members);
                      })}>Remove</button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </Table>
        )}
      </Show>
      <Show when={props.admin}>
        <form class="inline-form" onSubmit={add}>
          <label>User name<input name="subject" required maxlength="256" autocomplete="off" /></label>
          <label>Display name<input name="name" maxlength="200" autocomplete="off" /></label>
          <label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>
          <button type="submit">Add member</button>
        </form>
      </Show>
    </section>
  );
}

type Server = { name: string; url: string; headers: Record<string, string>; trusted: boolean; enabled: boolean; tools: string[] | null };

function McpServers(props: { admin: boolean }) {
  const servers = load(() => client().query("mcp.list", null, { retry: true }), "Loading MCP servers");
  const edit = (server?: Server) => openDialog({
    title: server ? `Edit ${server.name}` : "Add MCP server",
    body: () => (
      <>
        <label>Name<input name="name" value={server?.name ?? ""} required maxlength="40" pattern="[A-Za-z0-9_\-]+" readonly={server !== undefined} /></label>
        <label>URL<input name="url" type="url" value={server?.url ?? ""} required placeholder="https://mcp.example.com/mcp" /></label>
        <label>Headers
          <textarea name="headers" rows="3" placeholder="Authorization: Bearer ${secret:EXAMPLE_TOKEN}">{Object.entries(server?.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n")}</textarea>
          <span class="hint">One "Name: value" per line.</span>
        </label>
        <label class="check"><input type="checkbox" name="trusted" checked={server?.trusted ?? false} /> Trusted: run its tools without asking</label>
        <label class="check"><input type="checkbox" name="enabled" checked={server === undefined || server.enabled} /> Enabled</label>
      </>
    ),
    submit: async (form) => {
      const headers: Record<string, string> = {};
      for (const line of field(form, "headers").value.split("\n")) {
        if (line.trim() === "") continue;
        const colon = line.indexOf(":");
        if (colon <= 0) throw new Error(`Header line "${line.trim()}" needs a name and a value`);
        headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
      }
      await client().mutate("mcp.set", {
        name: field(form, "name").value.trim(), url: field(form, "url").value.trim(), headers,
        trusted: field(form, "trusted").checked, enabled: field(form, "enabled").checked,
      }, { retry: true });
      await refresh(servers);
    },
  });
  return (
    <section class="panel">
      <div class="panel-head"><h2>MCP servers</h2><Show when={props.admin}><button type="button" onClick={() => edit()}>Add server</button></Show></div>
      <p class="muted">Their tools are offered to every session. Tools of untrusted servers ask before each call. Header values may reference secrets as <code>{"${secret:NAME}"}</code>.</p>
      <Show when={servers()} fallback={<Loading />}>
        {(list) => (
          <Show when={list().length > 0} fallback={<p class="empty">No MCP servers.</p>}>
            <Table head={["Server", "Tools", "Approval"]}>
              <For each={list()} keyed={(server) => server.name}>
                {(server) => (
                  <tr>
                    <td><strong>{server().name}</strong><div class="muted small break">{server().url}</div></td>
                    <td>
                      <Show when={server().enabled} fallback={<span class="badge">Disabled</span>}>
                        <Show when={server().tools} fallback={<span class="muted">Discovering tools…</span>}>
                          {(tools) => <span title={tools().join(", ")}>{tools().length} tools</span>}
                        </Show>
                      </Show>
                    </td>
                    <td><Show when={server().trusted} fallback={<span class="badge">Asks first</span>}><span class="badge status-idle">Trusted</span></Show></td>
                    <td class="row-actions">
                      <Show when={props.admin}>
                        <button type="button" class="ghost" onClick={() => edit(server())}>Edit</button>
                        <button type="button" class="danger ghost" onClick={() => confirmAction("Remove MCP server?", `Sessions stop offering the tools of ${server().name}.`, "Remove", async () => {
                          await client().mutate("mcp.remove", { name: server().name }, { retry: true });
                          await refresh(servers);
                        })}>Remove</button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </Table>
          </Show>
        )}
      </Show>
    </section>
  );
}

function SlackWorkspaces(props: { admin: boolean }) {
  const slack = load(() => client().query("slack.status", null, { retry: true }), "Loading Slack workspaces");
  const install = (button: HTMLButtonElement) => busy(button, async () => {
    try {
      location.assign(await slackInstallUrl());
    } catch (error) {
      toast(describe(error));
    }
  });
  return (
    <section class="panel">
      <div class="panel-head"><h2>Slack</h2><Show when={props.admin}><button type="button" onClick={(event) => void install(event.currentTarget)}>Add a workspace</button></Show></div>
      <p class="muted">Mention Trinity in a channel, or send it a direct message: each thread is a session you can also continue here. People connect their Slack account the first time they ask.</p>
      <Show when={slack()} fallback={<Loading />}>
        {(status) => (
          <Show
            when={status().workspaces.length > 0}
            fallback={<p class="empty">No Slack workspace is connected. Run <code>trinity slack setup</code> from the Trinity checkout{props.admin ? ", or add one here when this deployment has an https address" : ""}.</p>}
          >
            <Table head={["Workspace", "You", "Connected"]}>
              <For each={status().workspaces} keyed={(workspace) => workspace.team}>
                {(workspace) => (
                  <tr>
                    <td><strong>{workspace().name}</strong><div class="muted small break">{workspace().url}</div></td>
                    <td>
                      <Show when={status().linked.some((link) => link.team === workspace().team)} fallback={<span class="muted">Mention Trinity there to connect</span>}>
                        <span class="badge status-idle">Connected as you</span>{" "}
                        <button type="button" class="ghost" onClick={(event) => void busy(event.currentTarget, async () => {
                          await client().mutate("slack.unlink", { team: workspace().team }, { retry: true });
                          await refresh(slack);
                        })}>Unlink</button>
                      </Show>
                    </td>
                    <td class="muted">{dateTime(workspace().installedAt)}</td>
                    <td class="row-actions">
                      <Show when={props.admin}>
                        <button type="button" class="danger ghost" onClick={() => confirmAction("Disconnect Slack workspace?", `Trinity stops answering in ${workspace().name}. Its threads stay here as sessions.`, "Disconnect", async () => {
                          await client().mutate("slack.uninstall", { team: workspace().team }, { retry: true });
                          await refresh(slack);
                        })}>Disconnect</button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </Table>
          </Show>
        )}
      </Show>
    </section>
  );
}
