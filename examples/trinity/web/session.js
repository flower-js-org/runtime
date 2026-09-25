// A session's live log and composer, and the view that starts a new session.
import { blobUrl, client, describe, fetchSegment, FlowerError, upload } from "./api.js";
import {
  formatBytes, formatDollars, groupDeltas, html, itemHtml, mergeEvents, partialHtml, queuedHtml, raw, sortedEvents, STATUS_LABELS, viewItems,
} from "./render.js";
import { busy, confirmAction, fromHtml, ICONS, modelOptions, openDialog, report, toast, topbar } from "./ui.js";

/** Events per session.tail page; a full page means resubscribing from its newest event. */
const PAGE = 200;
/** How much recent history opening a session shows before "Load earlier messages". */
const INITIAL = 120;

export function createComposer({ placeholder = "Message Trinity…", onSend, onHalt }) {
  const form = fromHtml(html`<form class="composer" aria-label="Send a message">
<div class="composer-files" hidden></div>
<div class="composer-box">
<label class="sr-only" for="composer-text">Message</label>
<textarea id="composer-text" rows="1" placeholder="${placeholder}"></textarea>
<div class="composer-bar">
<button type="button" class="icon-button" data-role="attach" aria-label="Attach files" title="Attach files">${raw(ICONS.attach)}</button>
<input type="file" multiple hidden data-role="files" tabindex="-1">
<label class="steer" hidden title="Deliver at the next step of the running turn instead of after it"><input type="checkbox" data-role="steer"> Steer</label>
<span class="composer-hint">Enter to send · Shift+Enter for a new line</span>
<button type="button" class="danger" data-role="halt" hidden>Halt</button>
<button type="submit" class="primary" data-role="send">Send</button>
</div></div></form>`);
  const textarea = form.querySelector("textarea");
  const picker = form.querySelector("[data-role=files]");
  const list = form.querySelector(".composer-files");
  const steer = form.querySelector(".steer");
  const halt = form.querySelector("[data-role=halt]");
  const send = form.querySelector("[data-role=send]");
  let files = [];

  const autosize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  };
  const renderFiles = () => {
    list.hidden = files.length === 0;
    list.innerHTML = files.map((file, index) => html`<span class="file-chip ${file.status}"><span class="file-name">${file.name}</span>
<span class="file-size">${file.status === "uploading" ? "Uploading…" : file.status === "error" ? "Failed" : formatBytes(file.size)}</span>
<button type="button" class="icon-button" data-remove="${index}" aria-label="Remove ${file.name}">×</button></span>`.html).join("");
  };
  const add = (chosen) => {
    for (const file of chosen) {
      const entry = { name: file.name || "pasted file", size: file.size, status: "uploading", attachment: null };
      files.push(entry);
      upload(file).then((attachment) => {
        entry.status = "ready";
        entry.attachment = attachment;
      }, (error) => {
        entry.status = "error";
        report(error, `Uploading ${entry.name}`);
      }).finally(renderFiles);
    }
    renderFiles();
  };

  textarea.addEventListener("input", autosize);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  textarea.addEventListener("paste", (event) => {
    if (event.clipboardData?.files.length) {
      event.preventDefault();
      add([...event.clipboardData.files]);
    }
  });
  form.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      form.classList.add("dropping");
    }
  });
  form.addEventListener("dragleave", () => form.classList.remove("dropping"));
  form.addEventListener("drop", (event) => {
    form.classList.remove("dropping");
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    add([...event.dataTransfer.files]);
  });
  form.querySelector("[data-role=attach]").addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    add([...picker.files]);
    picker.value = "";
  });
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    files.splice(Number(button.dataset.remove), 1);
    renderFiles();
  });
  halt.addEventListener("click", () => busy(halt, onHalt, "Halting"));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (files.some((file) => file.status === "uploading")) return toast("Wait for the uploads to finish.", "info");
    const attachments = files.filter((file) => file.status === "ready").map((file) => file.attachment);
    let text = textarea.value.trim();
    if (text === "" && attachments.length === 0) return;
    if (text === "") text = `Attached: ${attachments.map((each) => each.name).join(", ")}`;
    const draft = { value: textarea.value, files };
    const steering = !steer.hidden && steer.querySelector("input").checked;
    textarea.value = "";
    files = [];
    renderFiles();
    autosize();
    send.disabled = true;
    const sent = await onSend({ text, attachments, steer: steering });
    send.disabled = false;
    if (!sent && textarea.value === "") {
      textarea.value = draft.value;
      files = draft.files;
      renderFiles();
      autosize();
    }
  });

  return {
    element: form,
    focus: () => textarea.focus(),
    setDraft(text) {
      textarea.value = text;
      autosize();
    },
    /** Steering applies to a running turn; halting to any turn. */
    setState({ working, turn }) {
      steer.hidden = !working;
      if (!working) steer.querySelector("input").checked = false;
      halt.hidden = !turn;
    },
  };
}

/** Where a surface session's conversation lives, so people can switch between it and the web. */
function sourceLink(source) {
  const name = source.surface === "slack" ? "Slack" : source.surface === "github" ? "GitHub" : source.surface;
  const label = source.label ? `${name}, ${source.label}` : name;
  return source.url ? html`<a href="${source.url}" target="_blank" rel="noopener">Continue in ${label}</a>` : html`<span class="tag">${label}</span>`;
}

export class SessionView {
  constructor(main, sessionId, app) {
    this.main = main;
    this.id = sessionId;
    this.app = app;
    this.abort = new AbortController();
    this.events = new Map();
    this.userMessages = new Set();
    this.segments = new Map();
    this.pending = new Map();
    this.openKeys = new Set();
    this.session = null;
    this.partial = [];
    this.loadingEarlier = false;
    this.unavailable = false;
    this.rendered = { header: "", partial: "", queued: "" };
  }

  mount() {
    this.root = fromHtml(html`<div class="view session-view">
<div class="session-header"></div>
<div class="banner" hidden></div>
<div class="log"><div class="log-inner">
<div class="earlier" hidden><button type="button" data-action="earlier">Load earlier messages</button></div>
<div class="items" role="log" aria-label="Conversation" aria-relevant="additions"></div>
<div class="partial" aria-live="polite" aria-busy="false"></div>
<div class="queued"></div>
<div class="empty-log" hidden><p>No messages yet.</p></div>
</div></div>
<div class="readonly-note" hidden></div>
</div>`);
    this.header = this.root.querySelector(".session-header");
    this.banner = this.root.querySelector(".banner");
    this.log = this.root.querySelector(".log");
    this.itemsEl = this.root.querySelector(".items");
    this.partialEl = this.root.querySelector(".partial");
    this.queuedEl = this.root.querySelector(".queued");
    this.earlierEl = this.root.querySelector(".earlier");
    this.readonly = this.root.querySelector(".readonly-note");
    this.composer = createComposer({
      onSend: (message) => this.send(message),
      onHalt: () => client.mutate("session.halt", { session: this.id }, { retry: true }),
    });
    this.composer.element.hidden = true;
    this.root.append(this.composer.element);
    this.main.replaceChildren(this.root);
    this.root.addEventListener("click", (event) => this.onClick(event));
    this.root.addEventListener("submit", (event) => this.onSubmit(event));
    // Follow the bottom while the reader is there, including when images load or sections expand.
    this.stuck = true;
    this.log.addEventListener("scroll", () => { this.stuck = this.nearBottom(); }, { passive: true });
    this.resize = new ResizeObserver(() => { if (this.stuck) this.scrollToBottom(); });
    this.resize.observe(this.root.querySelector(".log-inner"));
    // Re-rendered items would lose their expanded sections; remember them.
    this.root.addEventListener("toggle", (event) => {
      const key = event.target.dataset?.k;
      if (!key) return;
      if (event.target.open) this.openKeys.add(key);
      else this.openKeys.delete(key);
    }, true);
    this.renderHeader();
    const draft = this.app.drafts.get(this.id);
    if (draft) {
      this.composer.setDraft(draft);
      this.app.drafts.delete(this.id);
    }
    this.start();
  }

  destroy() {
    this.abort.abort();
    this.resize?.disconnect();
  }

  async start() {
    const signal = this.abort.signal;
    try {
      const { value: session } = await client.query("session.get", { session: this.id }, { signal, retry: true });
      if (session === null) return this.showBanner("This session does not exist.");
      this.session = session;
      this.render();
      this.follow(Math.max(session.sealedThrough, session.seq - INITIAL));
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof FlowerError && error.failure?.code === "FORBIDDEN") {
        this.unavailable = true;
        return this.showBanner("This session is not available here. It may be private or belong to another organization; switch organizations from the menu.");
      }
      report(error, "Opening the session");
      this.showBanner(`Could not open this session: ${describe(error)}`, true);
    }
  }

  /** Watch the log from `after`, moving the cursor forward whenever a page fills. */
  async follow(after) {
    const signal = this.abort.signal;
    this.hideBanner();
    let first = true;
    while (!signal.aborted) {
      let full = false;
      try {
        for await (const { value } of client.subscribe("session.tail", { session: this.id, after, limit: PAGE }, { signal })) {
          if (value === null) return this.showBanner("This session no longer exists.");
          this.apply(value);
          if (first) {
            first = false;
            this.scrollToBottom();
            if (this.events.size === 0 && this.oldest() > 1) this.loadEarlier();
          }
          if (value.events.length >= PAGE) {
            after = value.events.at(-1).seq;
            full = true;
            break;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        report(error, "Live updates");
        return this.showBanner(`Live updates stopped: ${describe(error)}`, true);
      }
      if (!full) return;
    }
  }

  apply(value) {
    this.absorb(value.events);
    this.session = value.session;
    for (const segment of value.segments) this.segments.set(segment.from, segment);
    this.partial = value.partial ? groupDeltas(value.partial.deltas) : [];
    this.render();
  }

  absorb(events) {
    mergeEvents(this.events, events);
    for (const event of events) if (event.body.type === "user") this.userMessages.add(event.body.message);
  }

  oldest() {
    let oldest = Infinity;
    for (const seq of this.events.keys()) oldest = Math.min(oldest, seq);
    return oldest === Infinity ? (this.session?.seq ?? 0) + 1 : oldest;
  }

  nearBottom() {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80;
  }

  scrollToBottom() {
    this.log.scrollTop = this.log.scrollHeight;
  }

  render() {
    const stick = this.stuck;
    const s = this.session;
    this.renderHeader();
    this.reconcile(viewItems(sortedEvents(this.events), s));

    const partial = partialHtml(this.partial);
    if (partial !== this.rendered.partial) {
      this.partialEl.innerHTML = partial;
      this.partialEl.setAttribute("aria-busy", String(partial !== ""));
      this.rendered.partial = partial;
    }
    const queuedIds = new Set((s?.queued ?? []).map((each) => each.id));
    // IDs are fresh UUIDs, so one in the log or the queue means the send landed, even before its reply.
    for (const id of this.pending.keys()) if (this.userMessages.has(id) || queuedIds.has(id)) this.pending.delete(id);
    const queued = queuedHtml(s?.queued, [...this.pending.values()]);
    if (queued !== this.rendered.queued) {
      this.queuedEl.innerHTML = queued;
      this.rendered.queued = queued;
    }
    this.earlierEl.hidden = this.oldest() <= 1;
    this.earlierEl.querySelector("button").disabled = this.loadingEarlier;
    this.earlierEl.querySelector("button").textContent = this.loadingEarlier ? "Loading…" : "Load earlier messages";
    this.root.querySelector(".empty-log").hidden = !(s && s.seq === 0 && this.pending.size === 0);

    if (s) {
      const child = s.parent !== null;
      this.composer.element.hidden = child;
      this.readonly.hidden = !child;
      if (child) {
        this.readonly.innerHTML = html`A subagent works in this session; it takes work only from its parent. <a href="#/sessions/${encodeURIComponent(s.parent.session)}">Back to the parent session</a>`.html;
      }
      this.composer.setState({ working: s.turn !== null, turn: s.turn !== null });
    }
    if (stick) this.scrollToBottom();
  }

  /** Replace only items whose signature changed, keeping DOM order in step with the log. */
  reconcile(items) {
    const opts = { blobUrl: (key) => blobUrl(this.id, key), me: this.app.me };
    const existing = new Map();
    for (const node of this.itemsEl.children) existing.set(node.dataset.key, node);
    let previous = null;
    for (const item of items) {
      let node = existing.get(item.key);
      existing.delete(item.key);
      if (!node || node.dataset.sig !== item.sig) {
        const fresh = document.createElement("div");
        fresh.className = "item";
        fresh.dataset.key = item.key;
        fresh.dataset.sig = item.sig;
        fresh.innerHTML = itemHtml(item, opts);
        for (const details of fresh.querySelectorAll("details[data-k]")) if (this.openKeys.has(details.dataset.k)) details.open = true;
        if (node) node.replaceWith(fresh);
        node = fresh;
      }
      const expected = previous ? previous.nextElementSibling : this.itemsEl.firstElementChild;
      if (expected !== node) this.itemsEl.insertBefore(node, expected);
      previous = node;
    }
    for (const node of existing.values()) node.remove();
  }

  renderHeader() {
    const s = this.session;
    const title = s ? s.title ?? "Untitled session" : "Session";
    document.title = `${title} · Trinity`;
    const background = s ? Object.keys(s.background ?? {}).length : 0;
    const details = s ? html`<div class="subtitle">
<span class="badge status-${s.status}">${STATUS_LABELS[s.status] ?? s.status}</span>
${s.archived ? html`<span class="badge">Archived</span>` : ""}
${s.private ? html`<span class="tag" title="Only its creator sees this session">${raw(ICONS.lock)} Private</span>` : ""}
<span class="muted">${s.model}</span>
${s.computer ? html`<span class="muted">on ${s.computer}</span>` : html`<span class="muted">no computer</span>`}
<span class="muted" title="Spent in this session">${formatDollars(s.costNanos)}</span>
${s.parent ? html`<a href="#/sessions/${encodeURIComponent(s.parent.session)}">Parent session</a>` : ""}
${s.source ? sourceLink(s.source) : ""}
</div>` : "";
    const actions = s ? html`${background ? html`<span class="tag working">${background} in background <button type="button" class="link" data-action="stop-background">Stop</button></span>` : ""}
<button type="button" data-action="configure">Settings</button>
${s.parent === null && !s.archived ? html`<button type="button" data-action="archive" ${s.turn !== null ? raw("disabled title=\"Halt the running turn first\"") : ""}>Archive</button>` : ""}` : "";
    const markup = topbar(title, actions, details).html;
    if (markup === this.rendered.header) return;
    this.header.innerHTML = markup;
    this.rendered.header = markup;
  }

  showBanner(message, retry = false) {
    this.banner.hidden = false;
    this.banner.innerHTML = html`<span>${message}</span>${retry ? html`<button type="button" data-action="reconnect">Retry</button>` : ""}`.html;
  }

  hideBanner() {
    this.banner.hidden = true;
  }

  async send({ text, attachments, steer }) {
    const message = crypto.randomUUID();
    this.pending.set(message, { text, attachments });
    this.render();
    this.scrollToBottom();
    try {
      await client.mutate("session.send", {
        session: this.id, message, text, ...(steer ? { steer: true } : {}), ...(attachments.length ? { attachments } : {}),
      }, { requestId: message, retry: true });
      this.render();
      return true;
    } catch (error) {
      this.pending.delete(message);
      this.render();
      report(error, "Sending");
      return false;
    }
  }

  resolve(button, call, args) {
    const card = button.closest(".card");
    for (const each of card?.querySelectorAll("button") ?? []) each.disabled = true;
    return busy(null, () => client.mutate("session.resolve", { session: this.id, call, ...args }, { retry: true }), "Answering").then((result) => {
      // Success re-renders the card from the log; a failure leaves it to try again.
      if (result === undefined) for (const each of card?.querySelectorAll("button") ?? []) each.disabled = false;
    });
  }

  onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target || target.tagName === "FORM") return;
    const action = target.dataset.action;
    switch (action) {
      case "menu": return this.app.toggleDrawer();
      case "earlier": return this.loadEarlier();
      case "approve": return this.resolve(target, target.dataset.call, { approve: true });
      case "always": return this.resolve(target, target.dataset.call, { approve: true, always: true });
      case "deny": return this.resolve(target, target.dataset.call, { approve: false });
      case "copy": {
        const code = target.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
        return navigator.clipboard.writeText(code).then(() => {
          target.textContent = "Copied";
          setTimeout(() => { target.textContent = "Copy"; }, 1500);
        }, () => toast("Copying needs clipboard permission."));
      }
      case "configure": return this.configure();
      case "archive":
        return confirmAction("Archive this session?", "Its log moves to long-term storage. Sending a new message resumes it.", "Archive",
          () => client.mutate("session.archive", { session: this.id }, { retry: true }));
      case "stop-background":
        return busy(target, () => client.mutate("session.halt", { session: this.id, background: true }, { retry: true }), "Stopping");
      case "reconnect": {
        this.hideBanner();
        let newest = 0;
        for (const seq of this.events.keys()) newest = Math.max(newest, seq);
        return this.session === null ? this.start() : this.follow(newest || Math.max(this.session.sealedThrough, this.session.seq - INITIAL));
      }
    }
  }

  onSubmit(event) {
    const form = event.target.closest("form[data-action=answer]");
    if (!form) return;
    event.preventDefault();
    const answer = form.elements.answer.value.trim();
    if (answer === "") return;
    this.resolve(form.querySelector("button"), form.dataset.call, { answer });
  }

  /** Page back through the live log, then through sealed segments in blob storage. */
  async loadEarlier() {
    const oldest = this.oldest();
    if (this.loadingEarlier || oldest <= 1 || this.session === null) return;
    this.loadingEarlier = true;
    this.render();
    try {
      let earlier;
      const sealed = this.session.sealedThrough;
      if (oldest - 1 > sealed) {
        const after = Math.max(sealed, oldest - 1 - PAGE);
        const { value } = await client.query("session.tail", { session: this.id, after, limit: oldest - 1 - after }, { signal: this.abort.signal, retry: true });
        earlier = (value?.events ?? []).filter((event) => event.seq < oldest);
        for (const segment of value?.segments ?? []) this.segments.set(segment.from, segment);
      } else {
        const covering = () => [...this.segments.values()].find((segment) => segment.from <= oldest - 1 && oldest - 1 <= segment.to);
        if (!covering()) {
          const { value } = await client.query("session.tail", { session: this.id, after: 0, limit: 1 }, { signal: this.abort.signal, retry: true });
          for (const segment of value?.segments ?? []) this.segments.set(segment.from, segment);
        }
        const segment = covering();
        if (!segment) throw new Error("Earlier messages are unavailable");
        earlier = await fetchSegment(this.id, segment.key);
      }
      const fromBottom = this.log.scrollHeight - this.log.scrollTop;
      this.absorb(earlier);
      this.loadingEarlier = false;
      this.render();
      this.log.scrollTop = this.log.scrollHeight - fromBottom;
    } catch (error) {
      report(error, "Loading earlier messages");
    } finally {
      this.loadingEarlier = false;
      if (!this.abort.signal.aborted) this.render();
    }
  }

  async configure() {
    const s = this.session;
    if (s === null) return;
    let computers = [];
    try {
      computers = (await client.query("computer.list", null, { retry: true })).value;
    } catch (error) {
      report(error, "Listing computers");
    }
    const creator = s.createdBy === this.app.me;
    openDialog({
      title: "Session settings",
      body: html`<label>Title<input name="title" value="${s.title ?? ""}" maxlength="200" placeholder="Generated from the first message"></label>
<label>Model<input name="model" value="${s.model}" list="models" required></label>${modelOptions()}
<label>Computer<select name="computer"><option value="">None</option>${computers.map((each) => html`<option value="${each.id}" ${each.id === s.computer ? raw("selected") : ""}>${each.name} (${each.online ? "online" : "offline"})</option>`)}
${s.computer && !computers.some((each) => each.id === s.computer) ? html`<option value="${s.computer}" selected>${s.computer}</option>` : ""}</select></label>
<label>Tools that run without asking<input name="allow" value="${s.allow.join(", ")}" placeholder="bash, write_file"></label>
<label class="check"><input type="checkbox" name="webTools" ${s.webTools ? raw("checked") : ""}> Web search and fetch</label>
<label class="check"><input type="checkbox" name="private" ${s.private ? raw("checked") : ""} ${creator ? "" : raw("disabled")}> Private${creator ? "" : " (only the creator can change this)"}</label>`,
      submit: async (form) => {
        const title = form.elements.title.value.trim();
        const args = {
          session: this.id,
          title: title === "" ? null : title,
          model: form.elements.model.value.trim(),
          computer: form.elements.computer.value || null,
          allow: form.elements.allow.value.split(/[\s,]+/).filter(Boolean),
          webTools: form.elements.webTools.checked,
          ...(creator ? { private: form.elements.private.checked } : {}),
        };
        const { value } = await client.mutate("session.configure", args, { retry: true });
        this.session = { ...this.session, ...value };
        this.render();
      },
    });
  }
}

export class NewSessionView {
  constructor(main, app) {
    this.main = main;
    this.app = app;
    this.abort = new AbortController();
  }

  mount() {
    document.title = "New session · Trinity";
    const root = fromHtml(html`<div class="view new-session">${topbar("New session")}
<div class="log"><div class="log-inner new-session-body">
<div class="hero"><h2>What should Trinity work on?</h2><p class="muted">Describe the task. Trinity asks before running tools that change things.</p></div>
<details class="options"><summary>Options</summary><div class="options-grid">
<label>Model<input name="model" list="models" placeholder="Organization default"></label>${modelOptions()}
<label>Computer<select name="computer"><option value="default">Organization default</option><option value="none">No computer</option></select></label>
<label class="check"><input type="checkbox" name="private"> Private (only you can see it)</label>
</div></details></div></div></div>`);
    this.composer = createComposer({ placeholder: "Ask Trinity to do something…", onSend: (message) => this.send(message), onHalt: async () => {} });
    root.append(this.composer.element);
    root.addEventListener("click", (event) => {
      if (event.target.closest("[data-action=menu]")) this.app.toggleDrawer();
    });
    this.root = root;
    this.main.replaceChildren(root);
    this.composer.focus();
    this.loadComputers();
  }

  destroy() {
    this.abort.abort();
  }

  async loadComputers() {
    try {
      const { value } = await client.query("computer.list", null, { signal: this.abort.signal, retry: true });
      const select = this.root.querySelector("select[name=computer]");
      select.insertAdjacentHTML("beforeend", value.map((each) => html`<option value="${each.id}">${each.name} (${each.online ? "online" : "offline"})</option>`.html).join(""));
    } catch (error) {
      if (!this.abort.signal.aborted) report(error, "Listing computers");
    }
  }

  async send({ text, attachments }) {
    const id = crypto.randomUUID();
    const model = this.root.querySelector("input[name=model]").value.trim();
    const computer = this.root.querySelector("select[name=computer]").value;
    const args = {
      id,
      ...(model ? { model } : {}),
      ...(computer === "default" ? {} : { computer: computer === "none" ? null : computer }),
      ...(this.root.querySelector("input[name=private]").checked ? { private: true } : {}),
    };
    try {
      await client.mutate("session.create", args, { requestId: `create:${id}`, retry: true });
    } catch (error) {
      report(error, "Creating the session");
      return false;
    }
    const message = crypto.randomUUID();
    try {
      await client.mutate("session.send", { session: id, message, text, ...(attachments.length ? { attachments } : {}) }, { requestId: message, retry: true });
    } catch (error) {
      report(error, "Sending");
      this.app.drafts.set(id, text);
    }
    location.hash = `#/sessions/${encodeURIComponent(id)}`;
    return true;
  }
}
