// Pieces shared by the views: toasts, failure reports, dialogs, the top bar, icons and the hash route.
import type { Update } from "@flower-js/sdk/client";
import { createEffect, createMemo, createSignal, For, onSettled, Show, type SourceAccessor } from "solid-js";
import { render, type JSX } from "@solidjs/web";
import { describe, isAuthError, setToken, values } from "./api.ts";

export const MODELS = [
  "claude-opus-5", "claude-opus-5-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5",
];

export const ModelOptions = () => <datalist id="models"><For each={MODELS}>{(model) => <option value={model} />}</For></datalist>;

// Routing: #/, #/sessions/<id>, #/computers, #/automations, #/memory, #/usage, #/settings, #/connect/slack?grant=…

const [hash, setHash] = createSignal(location.hash);
window.addEventListener("hashchange", () => setHash(location.hash));

export interface Route { section: string; session: string | null; query: URLSearchParams }

export function route(): Route {
  const [path = "", query = ""] = hash().replace(/^#\/?/, "").split("?");
  const [section = "", id] = path.split("/");
  let session: string | null = null;
  if (section === "sessions" && id) {
    try {
      session = decodeURIComponent(id);
    } catch {
      // A mangled link opens the new-session view.
    }
  }
  return { section, session, query: new URLSearchParams(query) };
}

export const sessionHref = (id: string) => `#/sessions/${encodeURIComponent(id)}`;

export function navigate(target: string, replace = false): void {
  if (replace) {
    history.replaceState(null, "", target);
    setHash(location.hash);
  } else location.hash = target;
}

/** Keeps the document's title in step with a view's. */
export function documentTitle(title: () => string): void {
  createEffect(title, (value) => { document.title = `${value} · Trinity`; });
}

/** Ticks every 30 seconds, for relative times. */
const [nowSignal, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 30_000);
export const now = nowSignal;

/** Changes when the organization list may have (a rename in settings), for the sidebar to ask again. */
const [orgsVersionSignal, setOrgsVersion] = createSignal(0);
export const orgsVersion = orgsVersionSignal;
export const orgsChanged = () => setOrgsVersion((version) => version + 1);

// The drawer that holds the sidebar on narrow screens.
const [drawerSignal, setDrawer] = createSignal(false);
export const drawerOpen = drawerSignal;
export const toggleDrawer = (open?: boolean) => setDrawer((was) => open ?? !was);

// Toasts

interface Toast { id: number; message: string; kind: "error" | "info" }
const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastIds = 0;

export function toast(message: string, kind: Toast["kind"] = "error"): void {
  const id = ++toastIds;
  setToasts((list) => [...list, { id, message, kind }]);
  setTimeout(() => dismiss(id), kind === "error" ? 8000 : 4000);
}

const dismiss = (id: number) => setToasts((list) => list.filter((each) => each.id !== id));

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      <For each={toasts()}>
        {(each) => (
          <div class={["toast", each.kind]} role={each.kind === "error" ? "alert" : "status"}>
            <span>{each.message}</span>
            <button type="button" class="icon-button" aria-label="Dismiss" onClick={() => dismiss(each.id)}>×</button>
          </div>
        )}
      </For>
    </div>
  );
}

// Signing out

const [noticeSignal, setNotice] = createSignal("");
/** Why the sign-in form is showing, if not by choice. */
export const signInNotice = noticeSignal;

export function signOut(notice = ""): void {
  setNotice(notice);
  setToken(null);
}

/** Report a failure. Aborts are silent; an expired or rejected token ends the session. */
export function report(error: unknown, context = ""): void {
  if ((error as { name?: string } | null)?.name === "AbortError") return;
  if (isAuthError(error)) return signOut("Your sign-in expired. Please sign in again.");
  console.error(error);
  toast(context ? `${context}: ${describe(error)}` : describe(error));
}

/** A live query, null until its first value. A failure is reported, then thrown to the nearest Errored boundary. */
export function live<T>(subscribe: () => AsyncGenerator<Update<T>>, context: string): SourceAccessor<T | null> {
  return createMemo<T | null>(() => values(subscribe(), (error) => report(error, context)), { loadingValue: null });
}

/** A query's value, null until it arrives; `refresh()` asks again. Failures go as with `live`. */
export function load<T>(query: () => Promise<{ value: T }>, context: string): SourceAccessor<T | null> {
  return createMemo<T | null>(async () => {
    try {
      return (await query()).value;
    } catch (error) {
      report(error, context);
      throw error;
    }
  }, { loadingValue: null });
}

/** Run an action from a control, disabling it meanwhile. Returns the action's result, or undefined after reporting a failure. */
export async function busy<T>(control: HTMLButtonElement | HTMLSelectElement | null | undefined, action: () => Promise<T> | T, context = ""): Promise<T | undefined> {
  if (control) control.disabled = true;
  try {
    return await action();
  } catch (error) {
    report(error, context);
    return undefined;
  } finally {
    if (control?.isConnected) control.disabled = false;
  }
}

/** The submit button of the form an event came from. */
export const submitter = (event: SubmitEvent) => (event.submitter ?? (event.currentTarget as HTMLFormElement).querySelector("button[type=submit]")) as HTMLButtonElement | null;

/** A named control of a form, for its value or checked state. */
export const field = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement;

// Dialogs

interface DialogOptions {
  title: string;
  body: () => JSX.Element;
  submitLabel?: string;
  danger?: boolean;
  /** May throw to keep the dialog open. */
  submit: (form: HTMLFormElement) => unknown;
}

/** A modal form, rendered outside the view that opened it and disposed when it closes. */
export function openDialog(options: DialogOptions): void {
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(() => {
    let dialog!: HTMLDialogElement;
    let form!: HTMLFormElement;
    onSettled(() => {
      dialog.showModal();
      form.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]):not([readonly]), textarea, select")?.focus();
    });
    const submit = async (event: SubmitEvent) => {
      event.preventDefault();
      const done = await busy(submitter(event), async () => {
        await options.submit(form);
        return true;
      });
      if (done) dialog.close();
    };
    return (
      <dialog ref={dialog} class="dialog" aria-labelledby="dialog-title" onClose={() => { dispose(); host.remove(); }}>
        <form ref={form} method="dialog" class="dialog-form" onSubmit={submit}>
          <h2 id="dialog-title">{options.title}</h2>
          <div class="dialog-body">{options.body()}</div>
          <div class="actions">
            <button type="button" onClick={() => dialog.close()}>Cancel</button>
            <button type="submit" class={options.danger ? "danger" : "primary"}>{options.submitLabel ?? "Save"}</button>
          </div>
        </form>
      </dialog>
    );
  }, host);
}

export function confirmAction(title: string, message: string, label: string, action: () => unknown): void {
  openDialog({ title, body: () => <p>{message}</p>, submitLabel: label, danger: true, submit: action });
}

/** A URL-safe identifier from a display name, with a random suffix against collisions. */
export function slug(name: string, suffix = true): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "item";
  return suffix ? `${base}-${crypto.randomUUID().slice(0, 6)}` : base;
}

/** A view's header, with the drawer button for narrow screens. */
export function Topbar(props: { title: string; subtitle?: JSX.Element; actions?: JSX.Element }) {
  return (
    <header class="topbar">
      <button type="button" class="icon-button menu" aria-label="Show sessions" aria-controls="sidebar" onClick={() => toggleDrawer()}><MenuIcon /></button>
      <div class="title-block">
        <h1 class="title">{props.title}</h1>
        <Show when={props.subtitle}>{props.subtitle}</Show>
      </div>
      <div class="topbar-actions">{props.actions}</div>
    </header>
  );
}

export const MenuIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" /></svg>
);

export const AttachIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.5 3.5 0 015 5l-8.6 8.6a2 2 0 01-2.8-2.8l7.9-7.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" />
  </svg>
);

export const LockIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" />
    <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" stroke-width="2" fill="none" />
  </svg>
);

export const Brand = () => <><span class="brand-mark" aria-hidden="true" />Trinity</>;
