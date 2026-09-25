// Organization pages: settings, usage, computers, automations and memory.
import { client, currentAuth, describe, linkSlack, slackInstallUrl } from "./api.js";
import { dateTime, dollarsToNanos, formatBytes, formatDollars, formatTokens, html, nanosToDollars, raw, relativeTime } from "./render.js";
import { busy, confirmAction, fromHtml, modelOptions, openDialog, report, slug, toast, topbar } from "./ui.js";

class Page {
  constructor(main, app) {
    this.main = main;
    this.app = app;
    this.abort = new AbortController();
  }

  mount() {
    document.title = `${this.title} · Trinity`;
    this.root = fromHtml(html`<div class="view page-view">${topbar(this.title, raw(this.actions ?? ""))}<div class="page"><div class="page-inner"><p class="muted">Loading…</p></div></div></div>`);
    this.body = this.root.querySelector(".page-inner");
    this.root.addEventListener("click", (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      if (target.dataset.action === "menu") this.app.toggleDrawer();
      else this.onAction(target.dataset.action, target, event);
    });
    this.root.addEventListener("submit", (event) => {
      const form = event.target.closest("form[data-form]");
      if (!form) return;
      event.preventDefault();
      busy(form.querySelector("button[type=submit]"), () => this.onForm(form.dataset.form, form));
    });
    this.root.addEventListener("change", (event) => this.onChange?.(event));
    this.main.replaceChildren(this.root);
    this.reload();
  }

  reload() {
    this.load().catch((error) => {
      if (this.abort.signal.aborted) return;
      report(error, `Loading ${this.title.toLowerCase()}`);
      this.body.innerHTML = html`<p class="muted">Could not load this page.</p><button type="button" data-action="reload">Retry</button>`.html;
    });
  }

  destroy() {
    this.abort.abort();
  }

  async query(alias, args = null) {
    return (await client.query(alias, args, { signal: this.abort.signal, retry: true })).value;
  }

  mutate(alias, args) {
    return client.mutate(alias, args, { retry: true });
  }

  /**
   * Keep a query live. Browsers allow about six HTTP/1.1 connections per origin and each watch holds
   * one, so pages keep at most one open next to the session list.
   */
  async watch(alias, args, onValue) {
    try {
      for await (const { value } of client.subscribe(alias, args, { signal: this.abort.signal })) onValue(value);
    } catch (error) {
      if (!this.abort.signal.aborted) report(error, `Watching ${this.title.toLowerCase()}`);
    }
  }

  onAction(action) {
    if (action === "reload") this.reload();
  }

  onForm() {}
}

function computerOptions(computers, selected, empty = "None") {
  return html`<option value="">${empty}</option>${computers.map((each) => html`<option value="${each.id}" ${each.id === selected ? raw("selected") : ""}>${each.name}</option>`)}`;
}

export class SettingsPage extends Page {
  title = "Settings";

  async load() {
    const [{ org, role }, computers, members, servers] = await Promise.all([
      this.query("org.get"), this.query("computer.list"), this.query("org.members"), this.query("mcp.list"),
    ]);
    this.admin = role === "admin";
    this.org = org;
    this.members = members;
    this.servers = servers;
    const s = org.settings;
    const locked = this.admin ? "" : raw("disabled");
    this.body.innerHTML = html`
<section class="panel"><h2>Organization</h2>
${this.admin ? "" : html`<p class="muted">Only admins change these settings.</p>`}
<form data-form="org" class="form-grid"><fieldset ${locked}>
<label>Name<input name="name" value="${org.name}" required maxlength="200"></label>
<label>ID<input value="${org.id}" readonly></label>
<label>Default model<input name="model" value="${s.model}" list="models" required></label>${modelOptions()}
<label>Default computer<select name="computer">${computerOptions(computers, s.computer)}</select><span class="hint">For automations, Slack and GitHub, and sessions that don't choose one.</span></label>
<label>Monthly budget (USD)<input name="budget" inputmode="decimal" value="${nanosToDollars(s.budgetNanos)}" placeholder="No limit"><span class="hint">New turns stop once this month's spending reaches it.</span></label>
<label>Context limit (tokens)<input name="contextTokens" type="number" min="10000" max="900000" step="1000" value="${s.contextTokens}" required><span class="hint">Conversations are summarized before a request would exceed this.</span></label>
<label>Halt grace window (seconds)<input name="grace" type="number" min="0" max="600" step="1" value="${s.graceMs / 1000}" required><span class="hint">How long running tools may finish after a halt.</span></label>
<label class="check"><input type="checkbox" name="webTools" ${s.webTools ? raw("checked") : ""}> Web search and fetch in new sessions</label>
<div class="actions"><button type="submit" class="primary">Save settings</button></div>
</fieldset></form></section>
<section class="panel"><h2>Members</h2><div class="members"></div>
${this.admin ? html`<form data-form="member" class="inline-form"><label>User name<input name="subject" required maxlength="256" autocomplete="off"></label>
<label>Display name<input name="name" maxlength="200" autocomplete="off"></label>
<label>Role<select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>
<button type="submit">Add member</button></form>` : ""}</section>
<section class="panel"><div class="panel-head"><h2>MCP servers</h2>${this.admin ? html`<button type="button" data-action="mcp-add">Add server</button>` : ""}</div>
<p class="muted">Their tools are offered to every session. Tools of untrusted servers ask before each call. Header values may reference secrets as <code>\${secret:NAME}</code>.</p>
<div class="servers"></div></section>
<section class="panel"><div class="panel-head"><h2>Slack</h2>${this.admin ? html`<button type="button" data-action="slack-add">Add a workspace</button>` : ""}</div>
<p class="muted">Mention Trinity in a channel, or send it a direct message: each thread is a session you can also continue here. People connect their Slack account the first time they ask.</p>
<div class="slack"></div></section>`.html;
    this.renderMembers();
    this.renderServers();
    await this.renderSlack();
  }

  async renderSlack() {
    const { workspaces, linked } = await this.query("slack.status");
    const rows = workspaces.map((workspace) => html`<tr><td><strong>${workspace.name}</strong><div class="muted small break">${workspace.url}</div></td>
<td>${linked.some((link) => link.team === workspace.team) ? html`<span class="badge status-idle">Connected as you</span> <button type="button" class="ghost" data-action="slack-unlink" data-team="${workspace.team}">Unlink</button>` : html`<span class="muted">Mention Trinity there to connect</span>`}</td>
<td class="muted">${dateTime(workspace.installedAt)}</td>
<td class="row-actions">${this.admin ? html`<button type="button" class="danger ghost" data-action="slack-remove" data-team="${workspace.team}" data-name="${workspace.name}">Disconnect</button>` : ""}</td></tr>`);
    this.body.querySelector(".slack").innerHTML = workspaces.length === 0
      ? html`<p class="empty">No Slack workspace is connected. Run <code>trinity slack setup</code> from the Trinity checkout${this.admin ? ", or add one here when this deployment has an https address" : ""}.</p>`.html
      : html`<div class="table-wrap"><table class="table"><thead><tr><th>Workspace</th><th>You</th><th>Connected</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`.html;
  }

  renderMembers() {
    const rows = this.members.map((member) => html`<tr><td><div>${member.name ?? member.subject}</div>${member.name ? html`<div class="muted small">${member.subject}</div>` : ""}</td>
<td>${this.admin ? html`<label class="sr-only" for="role-${member.subject}">Role of ${member.subject}</label><select id="role-${member.subject}" data-member="${member.subject}"><option value="member" ${member.role === "member" ? raw("selected") : ""}>Member</option><option value="admin" ${member.role === "admin" ? raw("selected") : ""}>Admin</option></select>` : member.role === "admin" ? "Admin" : "Member"}</td>
<td class="muted">${dateTime(member.joinedAt)}</td>
<td class="row-actions">${this.admin ? html`<button type="button" class="danger ghost" data-action="member-remove" data-subject="${member.subject}">Remove</button>` : ""}</td></tr>`);
    this.body.querySelector(".members").innerHTML = html`<div class="table-wrap"><table class="table"><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`.html;
  }

  renderServers() {
    const container = this.body.querySelector(".servers");
    if (this.servers.length === 0) {
      container.innerHTML = html`<p class="empty">No MCP servers.</p>`.html;
      return;
    }
    const rows = this.servers.map((server) => html`<tr><td><strong>${server.name}</strong><div class="muted small break">${server.url}</div></td>
<td>${!server.enabled ? html`<span class="badge">Disabled</span>` : server.tools === null ? html`<span class="muted">Discovering tools…</span>` : html`<span title="${server.tools.join(", ")}">${server.tools.length} tools</span>`}</td>
<td>${server.trusted ? html`<span class="badge status-idle">Trusted</span>` : html`<span class="badge">Asks first</span>`}</td>
<td class="row-actions">${this.admin ? html`<button type="button" class="ghost" data-action="mcp-edit" data-name="${server.name}">Edit</button><button type="button" class="danger ghost" data-action="mcp-remove" data-name="${server.name}">Remove</button>` : ""}</td></tr>`);
    container.innerHTML = html`<div class="table-wrap"><table class="table"><thead><tr><th>Server</th><th>Tools</th><th>Approval</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`.html;
  }

  async onForm(name, form) {
    if (name === "org") {
      const values = form.elements;
      const settings = {
        model: values.model.value.trim(),
        computer: values.computer.value || null,
        budgetNanos: dollarsToNanos(values.budget.value),
        contextTokens: Number(values.contextTokens.value),
        graceMs: Math.round(Number(values.grace.value) * 1000),
        webTools: values.webTools.checked,
      };
      const { value } = await this.mutate("org.update", { name: values.name.value.trim(), settings });
      this.org = value;
      toast("Settings saved.", "info");
      this.app.refreshOrgs();
    } else if (name === "member") {
      const values = form.elements;
      await this.mutate("org.setMember", { subject: values.subject.value.trim(), role: values.role.value, ...(values.name.value.trim() ? { name: values.name.value.trim() } : {}) });
      form.reset();
      this.members = await this.query("org.members");
      this.renderMembers();
    }
  }

  async onChange(event) {
    const select = event.target.closest("select[data-member]");
    if (!select) return;
    const subject = select.dataset.member;
    const done = await busy(select, () => this.mutate("org.setMember", { subject, role: select.value }), "Changing the role");
    this.members = await this.query("org.members");
    this.renderMembers();
    if (done) toast(`${subject} is now ${select.value === "admin" ? "an admin" : "a member"}.`, "info");
  }

  onAction(action, target) {
    if (action === "reload") return this.reload();
    if (action === "slack-add") {
      return busy(target, async () => {
        try {
          location.assign(await slackInstallUrl());
        } catch (error) {
          toast(describe(error));
        }
      });
    }
    if (action === "slack-unlink") return busy(target, async () => { await this.mutate("slack.unlink", { team: target.dataset.team }); await this.renderSlack(); });
    if (action === "slack-remove") {
      return confirmAction("Disconnect Slack workspace?", `Trinity stops answering in ${target.dataset.name}. Its threads stay here as sessions.`, "Disconnect", async () => {
        await this.mutate("slack.uninstall", { team: target.dataset.team });
        await this.renderSlack();
      });
    }
    if (action === "member-remove") {
      const subject = target.dataset.subject;
      return confirmAction("Remove member?", `${subject} loses access to this organization.`, "Remove", async () => {
        await this.mutate("org.removeMember", { subject });
        this.members = await this.query("org.members");
        this.renderMembers();
      });
    }
    if (action === "mcp-remove") {
      const name = target.dataset.name;
      return confirmAction("Remove MCP server?", `Sessions stop offering the tools of ${name}.`, "Remove", async () => {
        await this.mutate("mcp.remove", { name });
        this.servers = await this.query("mcp.list");
        this.renderServers();
      });
    }
    if (action === "mcp-add" || action === "mcp-edit") {
      const server = this.servers.find((each) => each.name === target.dataset.name);
      const headers = Object.entries(server?.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
      openDialog({
        title: server ? `Edit ${server.name}` : "Add MCP server",
        body: html`<label>Name<input name="name" value="${server?.name ?? ""}" required maxlength="40" pattern="[A-Za-z0-9_\\-]+" ${server ? raw("readonly") : ""}></label>
<label>URL<input name="url" type="url" value="${server?.url ?? ""}" required placeholder="https://mcp.example.com/mcp"></label>
<label>Headers<textarea name="headers" rows="3" placeholder="Authorization: Bearer \${secret:EXAMPLE_TOKEN}">${headers}</textarea><span class="hint">One "Name: value" per line.</span></label>
<label class="check"><input type="checkbox" name="trusted" ${server?.trusted ? raw("checked") : ""}> Trusted: run its tools without asking</label>
<label class="check"><input type="checkbox" name="enabled" ${server === undefined || server.enabled ? raw("checked") : ""}> Enabled</label>`,
        submit: async (form) => {
          const parsed = {};
          for (const line of form.elements.headers.value.split("\n")) {
            if (line.trim() === "") continue;
            const colon = line.indexOf(":");
            if (colon <= 0) throw new Error(`Header line "${line.trim()}" needs a name and a value`);
            parsed[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
          }
          await this.mutate("mcp.set", {
            name: form.elements.name.value.trim(), url: form.elements.url.value.trim(), headers: parsed,
            trusted: form.elements.trusted.checked, enabled: form.elements.enabled.checked,
          });
          this.servers = await this.query("mcp.list");
          this.renderServers();
        },
      });
    }
  }
}

export class UsagePage extends Page {
  title = "Usage";

  async load() {
    const month = new Date().toISOString().slice(0, 7);
    this.body.innerHTML = html`<section class="panel"><div class="panel-head"><h2>Spending</h2>
<label class="inline">Month <input type="month" name="month" value="${month}" max="${month}"></label></div><div class="usage"><p class="muted">Loading…</p></div></section>`.html;
    this.follow(month);
  }

  follow(month) {
    this.abort.abort();
    this.abort = new AbortController();
    this.watch("org.usage", { month }, (value) => this.render(value));
  }

  onChange(event) {
    if (event.target.name === "month" && event.target.value) this.follow(event.target.value);
  }

  render(usage) {
    const budget = usage.budgetNanos;
    const share = budget ? Math.min(1, usage.costNanos / budget) : 0;
    const over = budget !== null && usage.costNanos >= budget;
    this.body.querySelector(".usage").innerHTML = html`<div class="stats">
<div class="stat"><div class="stat-label">Spent</div><div class="stat-value">${formatDollars(usage.costNanos)}</div><div class="muted small">${budget === null ? "No monthly budget" : `of ${formatDollars(budget)} budget`}</div></div>
<div class="stat"><div class="stat-label">Input tokens</div><div class="stat-value">${formatTokens(usage.input)}</div></div>
<div class="stat"><div class="stat-label">Output tokens</div><div class="stat-value">${formatTokens(usage.output)}</div></div>
<div class="stat"><div class="stat-label">Completions</div><div class="stat-value">${(usage.completions ?? 0).toLocaleString()}</div></div></div>
${budget === null ? "" : html`<div class="meter ${over ? "over" : share > 0.8 ? "near" : ""}" role="meter" aria-label="Budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(share * 100)}"><div class="meter-fill" style="width: ${(share * 100).toFixed(1)}%"></div></div>
<p class="muted small">${Math.round(share * 100)}% of the ${usage.month} budget${over ? " — new turns are refused until the budget is raised or the month ends" : ""}.</p>`}`.html;
  }
}

export class ComputersPage extends Page {
  title = "Computers";
  actions = html`<button type="button" class="primary" data-action="sandbox-add">New sandbox</button>`.html;

  async load() {
    this.body.innerHTML = html`<section class="panel"><div class="computers"><p class="muted">Loading…</p></div></section>
<section class="panel"><h2>Use your own machine</h2><p class="muted">Register it with the command line, then run its tools there:</p>
<pre class="code">bin/trinity computer register my-laptop "My laptop"
bin/trinity local --computer my-laptop --workspace ~/src/project</pre></section>`.html;
    this.watch("computer.list", null, (computers) => this.render(computers));
    this.timer = setInterval(() => this.computers && this.render(this.computers), 30_000);
    this.abort.signal.addEventListener("abort", () => clearInterval(this.timer));
  }

  render(computers) {
    this.computers = computers;
    const container = this.body.querySelector(".computers");
    if (computers.length === 0) {
      container.innerHTML = html`<p class="empty">No computers yet. Create a sandbox or register your own machine.</p>`.html;
      return;
    }
    const rows = computers.map((each) => {
      const state = each.kind === "local"
        ? html`<span class="badge ${each.online ? "status-idle" : ""}">${each.online ? "Online" : "Offline"}</span>${!each.online && each.lastSeenAt ? html` <span class="muted small">seen ${relativeTime(each.lastSeenAt)}</span>` : ""}`
        : html`<span class="badge ${each.state === "running" ? "status-idle" : each.state === "stopped" ? "" : "status-working"}">${each.state[0].toUpperCase() + each.state.slice(1)}</span>`;
      return html`<tr><td><strong>${each.name}</strong><div class="muted small">${each.id}</div></td>
<td>${each.kind === "local" ? "Local machine" : html`Sandbox <span class="muted small">${each.image}</span>`}</td><td>${state}</td><td class="muted">${each.owner}</td>
<td class="row-actions"><button type="button" class="danger ghost" data-action="computer-remove" data-id="${each.id}" data-name="${each.name}">Remove</button></td></tr>`;
    });
    container.innerHTML = html`<div class="table-wrap"><table class="table"><thead><tr><th>Computer</th><th>Kind</th><th>State</th><th>Owner</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`.html;
  }

  onAction(action, target) {
    if (action === "reload") return this.reload();
    if (action === "computer-remove") {
      return confirmAction("Remove computer?", `Sessions using ${target.dataset.name} can no longer run computer tools.`, "Remove",
        () => this.mutate("computer.remove", { id: target.dataset.id }));
    }
    if (action === "sandbox-add") {
      openDialog({
        title: "New sandbox",
        body: html`<p class="muted">A container that starts when a session needs it and stops after 30 idle minutes.</p>
<label>Name<input name="name" required maxlength="200" placeholder="Build box"></label>
<label>Image<input name="image" required maxlength="512" placeholder="node:24" value="node:24"></label>`,
        submitLabel: "Create",
        submit: (form) => this.mutate("computer.createSandbox", {
          id: slug(form.elements.name.value), name: form.elements.name.value.trim(), image: form.elements.image.value.trim(),
        }),
      });
    }
  }
}

export class AutomationsPage extends Page {
  title = "Automations";
  actions = html`<button type="button" class="primary" data-action="automation-add">New automation</button>`.html;

  async load() {
    const [automations, computers] = await Promise.all([this.query("automation.list"), this.query("computer.list")]);
    this.automations = automations;
    this.computers = computers;
    if (automations.length === 0) {
      this.body.innerHTML = html`<section class="panel"><p class="empty">No automations. They run a prompt as a new session on a schedule.</p></section>`.html;
      return;
    }
    const rows = automations.map((each) => html`<tr><td><strong>${each.name}</strong><div class="muted small clamp">${each.prompt}</div></td>
<td><code>${each.schedule}</code>${each.offsetMinutes ? html`<div class="muted small">UTC${each.offsetMinutes > 0 ? "+" : ""}${each.offsetMinutes / 60}h</div>` : html`<div class="muted small">UTC</div>`}</td>
<td>${each.enabled ? dateTime(each.nextAt) : html`<span class="badge">Paused</span>`}</td>
<td>${each.lastSession ? html`<a href="#/sessions/${encodeURIComponent(each.lastSession)}">${relativeTime(each.lastRunAt)}</a>` : html`<span class="muted">Never</span>`}</td>
<td class="row-actions"><button type="button" class="ghost" data-action="automation-run" data-id="${each.id}">Run now</button>
<button type="button" class="ghost" data-action="automation-toggle" data-id="${each.id}">${each.enabled ? "Pause" : "Resume"}</button>
<button type="button" class="ghost" data-action="automation-edit" data-id="${each.id}">Edit</button>
<button type="button" class="danger ghost" data-action="automation-delete" data-id="${each.id}">Delete</button></td></tr>`);
    this.body.innerHTML = html`<section class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Automation</th><th>Schedule</th><th>Next run</th><th>Last run</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div></section>`.html;
  }

  save(automation) {
    const { id, name, schedule, offsetMinutes, prompt, model, computer, enabled } = automation;
    return this.mutate("automation.set", { id, name, schedule, offsetMinutes, prompt, model, computer, enabled });
  }

  async onAction(action, target) {
    if (action === "reload") return this.reload();
    const automation = this.automations?.find((each) => each.id === target.dataset.id);
    if (action === "automation-run") {
      const result = await busy(target, () => this.mutate("automation.run", { id: automation.id }), "Running");
      if (result) location.hash = `#/sessions/${encodeURIComponent(result.value.session)}`;
    } else if (action === "automation-toggle") {
      if (await busy(target, () => this.save({ ...automation, enabled: !automation.enabled }), "Saving")) await this.load();
    } else if (action === "automation-delete") {
      confirmAction("Delete automation?", `${automation.name} stops running.`, "Delete", async () => {
        await this.mutate("automation.delete", { id: automation.id });
        await this.load();
      });
    } else if (action === "automation-add" || action === "automation-edit") {
      const offset = -new Date().getTimezoneOffset();
      openDialog({
        title: automation ? `Edit ${automation.name}` : "New automation",
        body: html`<label>Name<input name="name" value="${automation?.name ?? ""}" required maxlength="200" placeholder="Daily report"></label>
<label>Schedule<input name="schedule" value="${automation?.schedule ?? ""}" required maxlength="200" placeholder="0 9 * * 1-5"><span class="hint">Five-field cron (minute hour day month weekday), or @daily, @hourly and the like.</span></label>
<label>UTC offset (minutes)<input name="offset" type="number" min="-1080" max="1080" step="1" value="${automation?.offsetMinutes ?? offset}"><span class="hint">The schedule's time zone; yours is ${offset}.</span></label>
<label>Prompt<textarea name="prompt" rows="5" required>${automation?.prompt ?? ""}</textarea></label>
<label>Model<input name="model" list="models" value="${automation?.model ?? ""}" placeholder="Organization default"></label>${modelOptions()}
<label>Computer<select name="computer">${computerOptions(this.computers ?? [], automation?.computer ?? null)}</select></label>
<label class="check"><input type="checkbox" name="enabled" ${automation === undefined || automation.enabled ? raw("checked") : ""}> Enabled</label>`,
        submitLabel: automation ? "Save" : "Create",
        submit: async (form) => {
          const values = form.elements;
          await this.save({
            id: automation?.id ?? slug(values.name.value),
            name: values.name.value.trim(),
            schedule: values.schedule.value.trim(),
            offsetMinutes: Number(values.offset.value || 0),
            prompt: values.prompt.value,
            model: values.model.value.trim() || null,
            computer: values.computer.value || null,
            enabled: values.enabled.checked,
          });
          await this.load();
        },
      });
    }
  }
}

export class MemoryPage extends Page {
  title = "Memory";
  scope = "org";

  async load() {
    this.body.innerHTML = html`<section class="panel memory">
<div class="panel-head"><div class="segmented" role="group" aria-label="Memory scope">
<button type="button" data-action="scope" data-scope="org" aria-pressed="${this.scope === "org"}">Organization</button>
<button type="button" data-action="scope" data-scope="user" aria-pressed="${this.scope === "user"}">Personal</button></div>
<button type="button" data-action="memory-new">New file</button></div>
<p class="muted small">Agents read and write these files. Each scope's <code>index.md</code> is shown to the agent at the start of every turn.</p>
<div class="memory-layout"><nav class="memory-files" aria-label="Memory files"><p class="muted">Loading…</p></nav><div class="memory-editor"></div></div></section>`.html;
    await this.list();
  }

  async list(select) {
    const files = await this.query("memory.list", { scope: this.scope });
    const nav = this.body.querySelector(".memory-files");
    nav.innerHTML = files.length === 0
      ? html`<p class="empty">No files in this scope.</p>`.html
      : files.map((file) => html`<button type="button" class="memory-file" data-action="memory-open" data-path="${file.path}" aria-current="${file.path === select}">
<span class="memory-path">${file.path}</span><span class="muted small">${formatBytes(file.size)} · ${relativeTime(file.updatedAt)}</span></button>`.html).join("");
    if (select === undefined) this.edit(null);
  }

  edit(file) {
    const editor = this.body.querySelector(".memory-editor");
    editor.innerHTML = html`<form data-form="memory" class="memory-form">
<label>Path<input name="path" value="${file?.path ?? ""}" placeholder="notes.md" required maxlength="256" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*(/[A-Za-z0-9][A-Za-z0-9._\\-]*)*" ${file ? raw("readonly") : ""}></label>
<label>Content<textarea name="content" rows="18" maxlength="100000" spellcheck="true">${file?.content ?? ""}</textarea></label>
${file ? html`<p class="muted small">Updated ${dateTime(file.updatedAt)} by ${file.updatedBy}</p>` : ""}
<div class="actions">${file ? html`<button type="button" class="danger ghost" data-action="memory-delete" data-path="${file.path}">Delete</button>` : ""}<button type="submit" class="primary">Save</button></div></form>`.html;
  }

  async onForm(name, form) {
    const path = form.elements.path.value.trim();
    await this.mutate("memory.write", { path, content: form.elements.content.value, scope: this.scope });
    toast(`Saved ${path}.`, "info");
    await this.list(path);
    this.edit(await this.query("memory.read", { path, scope: this.scope }));
  }

  async onAction(action, target) {
    if (action === "reload") return this.reload();
    if (action === "scope") {
      this.scope = target.dataset.scope;
      return this.load();
    }
    if (action === "memory-new") return this.edit(null);
    if (action === "memory-open") {
      const path = target.dataset.path;
      for (const each of this.body.querySelectorAll(".memory-file")) each.setAttribute("aria-current", String(each.dataset.path === path));
      const file = await busy(null, () => this.query("memory.read", { path, scope: this.scope }), "Opening");
      if (file) this.edit(file);
      else if (file === null) toast(`${path} no longer exists.`);
    }
    if (action === "memory-delete") {
      const path = target.dataset.path;
      confirmAction("Delete memory file?", `Agents will no longer see ${path}.`, "Delete", async () => {
        await this.mutate("memory.delete", { path, scope: this.scope });
        await this.list();
      });
    }
  }
}

/** Where the Slack worker sends someone it does not know yet: link their Slack account to the signed-in member. */
export class SlackConnectPage extends Page {
  title = "Connect Slack";

  async load() {
    this.grant = new URLSearchParams(location.hash.split("?")[1] ?? "").get("grant");
    const auth = currentAuth();
    this.body.innerHTML = this.grant === null
      ? html`<section class="panel"><h2>Nothing to connect</h2><p class="muted">Mention Trinity in Slack to get a link here.</p></section>`.html
      : html`<section class="panel"><h2>Connect your Slack account</h2>
<p>Messages you send Trinity in Slack, and buttons you press there, will act as you${auth?.claims?.org ? html` in <strong>${auth.claims.org}</strong>` : ""}.</p>
<div class="actions"><button type="button" class="primary" data-action="connect">Connect</button></div><p class="result muted" role="status"></p></section>`.html;
  }

  onAction(action, target) {
    if (action === "reload") return this.reload();
    if (action !== "connect") return;
    return busy(target, async () => {
      const result = this.body.querySelector(".result");
      try {
        const { workspace } = await linkSlack(this.grant);
        result.textContent = `Connected to ${workspace}. Go back to Slack and mention Trinity again.`;
        target.remove();
      } catch (error) {
        result.textContent = describe(error);
      }
    });
  }
}
