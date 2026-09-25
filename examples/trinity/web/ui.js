// DOM helpers shared by the views.
import { describe, isAuthError } from "./api.js";
import { html, raw } from "./render.js";

export const MODELS = [
  "claude-opus-5", "claude-opus-5-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
];

export const modelOptions = () => html`<datalist id="models">${MODELS.map((model) => html`<option value="${model}"></option>`)}</datalist>`;

export function fromHtml(markup) {
  const template = document.createElement("template");
  template.innerHTML = String(markup).trim();
  return template.content.firstElementChild;
}

export function toast(message, kind = "error") {
  const region = document.getElementById("toasts");
  const node = fromHtml(html`<div class="toast ${kind}" role="${kind === "error" ? "alert" : "status"}"><span>${message}</span><button type="button" class="icon-button" aria-label="Dismiss">×</button></div>`);
  const dismiss = () => node.remove();
  node.querySelector("button").addEventListener("click", dismiss);
  region.append(node);
  setTimeout(dismiss, kind === "error" ? 8000 : 4000);
}

let onAuthLost = () => {};
export const setAuthLostHandler = (handler) => { onAuthLost = handler; };

/** Report a failure. Aborts are silent; an expired or rejected token ends the session. */
export function report(error, context = "") {
  if (error?.name === "AbortError") return;
  if (isAuthError(error)) return onAuthLost("Your sign-in expired. Please sign in again.");
  console.error(error);
  toast(context ? `${context}: ${describe(error)}` : describe(error));
}

/** Run an action from a button, disabling it meanwhile. Returns the action's result, or undefined after reporting a failure. */
export async function busy(button, action, context) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (error) {
    report(error, context);
    return undefined;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

/** A modal form. `submit(form)` may throw to keep the dialog open. */
export function openDialog({ title, body, submitLabel = "Save", submit, danger = false }) {
  const dialog = fromHtml(html`<dialog class="dialog" aria-labelledby="dialog-title"><form method="dialog" class="dialog-form">
<h2 id="dialog-title">${title}</h2><div class="dialog-body">${raw(String(body))}</div>
<div class="actions"><button type="button" data-close>Cancel</button><button type="submit" class="${danger ? "danger" : "primary"}">${submitLabel}</button></div></form></dialog>`);
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const done = await busy(button, async () => {
      await submit(form);
      return true;
    });
    if (done) dialog.close();
  });
  dialog.showModal();
  form.querySelector("input:not([type=hidden]):not([disabled]), textarea, select")?.focus();
  return dialog;
}

export function confirmAction(title, message, label, action) {
  openDialog({ title, body: html`<p>${message}</p>`, submitLabel: label, danger: true, submit: action });
}

/** A URL-safe identifier from a display name, with a random suffix against collisions. */
export function slug(name, suffix = true) {
  const base = String(name).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "item";
  return suffix ? `${base}-${crypto.randomUUID().slice(0, 6)}` : base;
}

/** A page header with the drawer button for narrow screens. */
export function topbar(title, actions = "", subtitle = "") {
  return html`<header class="topbar"><button type="button" class="icon-button menu" data-action="menu" aria-label="Show sessions" aria-controls="sidebar">${raw(ICONS.menu)}</button>
<div class="title-block"><h1 class="title">${title}</h1>${raw(String(subtitle))}</div><div class="topbar-actions">${raw(String(actions))}</div></header>`;
}

export const ICONS = {
  menu: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
  attach: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.5 3.5 0 015 5l-8.6 8.6a2 2 0 01-2.8-2.8l7.9-7.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
};

export function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}
