import { FlowerClient } from "../../sdk/index.ts";
import type pizza from "../goblin-pizza.ts";
import type { PizzaDashboard, PizzaOrder } from "../goblin-pizza.ts";

const client = new FlowerClient<typeof pizza>(window.location.origin);
const lifetime = new AbortController();
const number = new Intl.NumberFormat();
const colors = ["#eab983", "#bdcca1", "#dec68d", "#d5b9a3"];
const symbols = ["✳", "✿", "❋", "✦"];
let value: PizzaDashboard | undefined;
let revision = 0;
let received = 0;
let lastChange = 0;
let connected = false;
let paused = document.querySelector<HTMLMetaElement>('meta[name="pizza-demo-paused"]')?.content === "true";
let filter = "all";
let shopIds = "";
let actionPending = false;
let selectedTenant = "tenant-0";
let watchController: AbortController | undefined;

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing dashboard element ${id}`);
  return node as T;
}
function text(id: string, value: string | number): void { element(id).textContent = String(value); }
function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
function shortId(id: string): string { return id.length > 20 ? `${id.slice(0, 9)}…${id.slice(-8)}` : id; }
function deadline(time: number): string { return `<span data-deadline="${time}">~${Math.max(0, (time - Date.now()) / 1000).toFixed(1)}s</span>`; }
function elapsed(from: number, until: number): string { return `${Math.max(0, (until - from) / 1000).toFixed(1)}s total`; }
function shopName(id: string): string { return value?.summaries[id]?.name ?? id; }
function status(state: "connecting" | "connected" | "disconnected", message?: string): void {
  connected = state === "connected";
  element("connection").className = `connection ${state}`;
  text("connection-text", message ?? (connected ? "Replica stream connected" : state === "connecting" ? "Connecting" : "Reconnecting"));
  element("stale-banner").hidden = connected || !value;
  document.body.classList.toggle("stale-data", !connected && Boolean(value));
  updateControls();
}
function updateControls(): void {
  for (const id of ["order", "tip"]) element<HTMLButtonElement>(id).disabled = !connected || !value || value.tenant !== selectedTenant || actionPending;
  element<HTMLSelectElement>("shop").disabled = !value || value.tenant !== selectedTenant || actionPending;
  element<HTMLSelectElement>("tenant").disabled = !value || actionPending;
  element<HTMLButtonElement>("pause").disabled = actionPending;
  element<HTMLButtonElement>("crash").disabled = actionPending;
}
function renderOrders(): void {
  if (!value) return;
  const recent = Object.values(value.orders).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const visible = recent.filter((order) => filter === "all" || order.status === filter).slice(0, 12);
  element("orders").innerHTML = visible.length ? visible.map((order: PizzaOrder) => {
    const job = value!.jobs[order.key];
    const timing = order.status === "baking" ? deadline(order.dueAt) : order.deliveredAt !== null
      ? elapsed(order.createdAt, order.deliveredAt) : job?.lease ? deadline(job.lease.expiresAt) : "Awaiting drone";
    return `<tr><td class="order-id" title="${escape(order.key)}">${escape(shortId(order.id))}<small>${escape(shopName(JSON.stringify(order.shop)))}</small></td><td>${number.format(order.quantity)} <span aria-hidden="true">↗</span></td><td><span class="status-badge ${order.status}">${order.status === "baking" ? "Baking" : order.status === "ready" ? job?.lease ? "In flight" : "Ready" : "Delivered"}</span></td><td class="timing">${timing}</td></tr>`;
  }).join("") : `<tr><td colspan="4" class="empty">${filter === "all" ? "No orders yet. The ovens are ready when you are." : `No ${escape(filter)} orders in the recent window.`}</td></tr>`;
  text("orders-foot", `Showing ${visible.length} of ${recent.length} recent orders · the board retains the latest 120`);
}
function render(): void {
  if (!value) return;
  const totals = value.totals;
  text("pizzas", number.format(totals.pizzas));
  text("in-flight", number.format(totals.baking + totals.ready));
  text("revenue", number.format(totals.revenue));
  text("tips", number.format(totals.tips));
  text("total-orders", `${value.tenant} · ${number.format(totals.orders)} orders through the kitchens`);
  const tenantSelector = element<HTMLSelectElement>("tenant");
  if (JSON.stringify([...tenantSelector.options].map((option) => option.value)) !== JSON.stringify(value.tenantIds)) {
    tenantSelector.innerHTML = value.tenantIds.map((tenant) => `<option value="${escape(tenant)}">${escape(tenant)}</option>`).join("");
  }
  tenantSelector.value = selectedTenant;
  for (const state of ["baking", "ready", "delivered"] as const) {
    text(state, number.format(totals[state]));
    element(`${state}-bar`).style.width = `${100 * totals[state] / Math.max(1, totals.orders)}%`;
  }
  const identities = JSON.stringify(value.config.shopIds);
  if (identities !== shopIds) {
    const selector = element<HTMLSelectElement>("shop");
    const previous = selector.value;
    const keys = value.config.shopIds.map((id) => JSON.stringify(id));
    selector.innerHTML = keys.map((id) => `<option value="${escape(id)}">${escape(shopName(id))}</option>`).join("");
    if (keys.includes(previous)) selector.value = previous;
    shopIds = identities;
  }
  element("shops").innerHTML = value.leaderboard.map((id, rank) => {
    const shop = value!.summaries[id];
    if (!shop) return "";
    const index = value!.config.shopIds.findIndex((ref) => JSON.stringify(ref) === id);
    return `<article class="shop-card" style="--shop-color:${colors[index % colors.length]}"><div class="shop-top"><span class="shop-icon" aria-hidden="true">${symbols[index % symbols.length]}</span><div><h3>${escape(shop.name)}</h3><p>${number.format(shop.baking)} baking · ${number.format(shop.ready)} ready to fly</p></div><span class="rank">#${rank + 1}</span></div><div class="shop-money"><strong>${number.format(shop.revenue)} <small>copper</small></strong><small>${number.format(shop.delivered)} delivered</small></div><div class="stock-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, 100 * shop.stock / Math.max(1, shop.initialStock)))}%"></i></div><div class="stock-label"><span>Dough in the pantry</span><span>${number.format(shop.stock)} / ${number.format(shop.initialStock)}</span></div></article>`;
  }).join("");
  renderOrders();
  const jobs = Object.values(value.jobs);
  const leased = jobs.filter((job) => job.state === "leased" && job.lease).sort((a, b) => a.lease!.expiresAt - b.lease!.expiresAt);
  text("lease-count", leased.length);
  element("leases").innerHTML = leased.length ? leased.slice(0, 5).map((job) => `<div class="dispatch-row"><div><strong>${escape(job.lease!.owner)}</strong>${deadline(job.lease!.expiresAt)}</div><p>${escape(shortId(job.id))} · fence #${job.lease!.token} · attempt ${job.attempts}</p></div>`).join("") : '<p class="empty">All drones are back at the roost.<br>The next delivery is on its way.</p>';
  const pending = jobs.filter((job) => job.state === "pending").length;
  text("queue-count", `${pending} waiting for pickup · ${leased.length} active leases in the recent window`);
  const timers = Object.values(value.timers).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  text("timer-count", timers.length);
  element("timers").innerHTML = timers.length ? timers.slice(0, 5).map((timer) => `<div class="dispatch-row"><div><strong>${escape(shortId(timer.id.replace(/^bake:/, "")))}</strong>${timer.state === "failed" ? '<span>Needs attention</span>' : deadline(timer.dueAt)}</div><p>${escape(timer.handler)} · ${timer.attempts ? `${timer.attempts} attempts` : "waiting for the bell"}</p></div>`).join("") : '<p class="empty">The ovens have a moment to breathe.<br>Place an order to put them back to work.</p>';
  updateControls();
  tick();
}
function tick(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-deadline]")) {
    const remaining = Number(node.dataset.deadline) - Date.now();
    node.textContent = remaining > 0 ? `~${(remaining / 1000).toFixed(1)}s` : "Due · awaiting update";
  }
  if (value) text("stream-detail", `Revision ${number.format(revision)} · ${number.format(received)} values received · last change ${Math.max(0, Math.floor((Date.now() - lastChange) / 1000))}s ago`);
}
async function action(action: "order" | "tip" | "pause" | "crash"): Promise<void> {
  if (actionPending) return;
  actionPending = true;
  updateControls();
  element("action-status").classList.remove("error");
  text("action-status", action === "crash" ? "Stopping the leader. The other nodes are choosing a replacement…" : "Sending it to the kitchens…");
  try {
    const response = await fetch("/demo/action", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...(["order", "tip"].includes(action) ? { shop: JSON.parse(element<HTMLSelectElement>("shop").value) } : {}) }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]),
    });
    const result = await response.json() as { ok: boolean; paused?: boolean; error?: string | { message?: string } };
    if (!response.ok || !result.ok) throw new Error(typeof result.error === "string" ? result.error : result.error?.message ?? "The kitchen could not accept that action.");
    if (typeof result.paused === "boolean" || action === "pause") {
      paused = result.paused ?? !paused;
      element("pause").setAttribute("aria-pressed", String(paused));
      text("pause", paused ? "Resume arrivals ▷" : "Pause arrivals Ⅱ");
    }
    text("action-status", action === "order" ? "Order accepted. It will appear when this replica catches up." : action === "tip" ? "Three copper coins for the goblins. The board will catch up." : action === "pause" ? paused ? "Automatic arrivals paused. The drones are still delivering." : "Automatic arrivals resumed. Here comes the next rush." : "A new leader is serving. The board streams from an available replica.");
  } catch (error) {
    if (!lifetime.signal.aborted) {
      element("action-status").classList.add("error");
      text("action-status", error instanceof Error ? error.message : "Action failed. Please try again.");
    }
  } finally { actionPending = false; updateControls(); }
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    lifetime.signal.addEventListener("abort", done, { once: true });
    if (lifetime.signal.aborted) done();
  });
}
async function connect(): Promise<void> {
  let retry = 250;
  while (!lifetime.signal.aborted) {
    const tenant = selectedTenant;
    watchController = new AbortController();
    status(value ? "disconnected" : "connecting");
    try {
      // This is the only application read. One query supplies the entire page;
      // the SDK reconstructs its value from snapshot/patch SSE events. Its
      // replica-local policy permits older state, also across reconnections.
      for await (const update of client.watch("pizza.dashboard", { tenant },
        { signal: AbortSignal.any([lifetime.signal, watchController.signal]) })) {
        if (tenant !== selectedTenant) continue;
        value = update.value;
        revision = update.revision;
        received++;
        lastChange = Date.now();
        retry = 250;
        status("connected");
        render();
      }
      if (!lifetime.signal.aborted) throw new Error("The watch stream ended");
    } catch (error) {
      if (lifetime.signal.aborted) return;
      if (tenant !== selectedTenant) continue;
      status("disconnected", `Reconnecting in ${(retry / 1000).toFixed(1)}s`);
      element("stale-banner").textContent = "Connection lost. Showing the last received replica state. Reconnecting with a new snapshot…";
      if (!value) text("action-status", `Waiting for the kitchens: ${error instanceof Error ? error.message : "connection unavailable"}`);
    }
    if (tenant !== selectedTenant) continue;
    await wait(retry);
    retry = Math.min(5_000, retry * 2);
  }
}
element<HTMLSelectElement>("tenant").addEventListener("change", () => {
  selectedTenant = element<HTMLSelectElement>("tenant").value;
  status("disconnected", `Loading ${selectedTenant}`);
  text("stale-banner", `Switching tenants. Showing the last received ${value?.tenant ?? "kitchen"} state until the new snapshot arrives.`);
  watchController?.abort(new Error("Tenant changed"));
});
for (const id of ["order", "tip", "pause", "crash"] as const) element(id).addEventListener("click", () => { void action(id); });
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
  button.addEventListener("click", () => {
    filter = button.dataset.filter!;
    for (const item of document.querySelectorAll("[data-filter]")) item.setAttribute("aria-pressed", String(item === button));
    renderOrders();
    tick();
  });
}
if (paused) {
  element("pause").setAttribute("aria-pressed", "true");
  text("pause", "Resume arrivals ▷");
  text("action-status", "Automatic arrivals paused. The drones are still delivering.");
}
const localClock = setInterval(tick, 250);
window.addEventListener("pagehide", () => { lifetime.abort(); clearInterval(localClock); }, { once: true });
// A restored page had its stream deliberately closed when it was cached. Reload
// to create one fresh watch and refresh the launcher’s initial pause metadata.
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });
void connect();
