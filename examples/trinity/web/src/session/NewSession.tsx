// The view that starts a session with its first message.
import { Errored, For, Show } from "solid-js";
import { client } from "../api.ts";
import { documentTitle, load, ModelOptions, navigate, report, sessionHref, Topbar } from "../ui.tsx";
import { Composer, type Message } from "./Composer.tsx";
import { drafts } from "./Session.tsx";

export function NewSessionView() {
  documentTitle(() => "New session");
  let model!: HTMLInputElement;
  let computer!: HTMLSelectElement;
  let privately!: HTMLInputElement;
  const computers = load(() => client().query("computer.list", null, { retry: true }), "Listing computers");

  async function send({ text, attachments }: Message): Promise<boolean> {
    const id = crypto.randomUUID();
    const chosen = computer.value;
    try {
      await client().mutate("session.create", {
        id,
        ...(model.value.trim() ? { model: model.value.trim() } : {}),
        ...(chosen === "default" ? {} : { computer: chosen === "none" ? null : chosen }),
        ...(privately.checked ? { private: true } : {}),
      }, { requestId: `create:${id}`, retry: true });
    } catch (error) {
      report(error, "Creating the session");
      return false;
    }
    const message = crypto.randomUUID();
    try {
      await client().mutate("session.send", { session: id, message, text, ...(attachments.length ? { attachments } : {}) }, { requestId: message, retry: true });
    } catch (error) {
      report(error, "Sending");
      drafts.set(id, text);
    }
    navigate(sessionHref(id));
    return true;
  }

  return (
    <div class="view new-session">
      <Topbar title="New session" />
      <div class="log">
        <div class="log-inner new-session-body">
          <div class="hero">
            <h2>What should Trinity work on?</h2>
            <p class="muted">Describe the task. Trinity asks before running tools that change things.</p>
          </div>
          <details class="options">
            <summary>Options</summary>
            <div class="options-grid">
              <label>Model<input ref={model} name="model" list="models" placeholder="Organization default" /></label>
              <ModelOptions />
              <label>Computer
                <select ref={computer} name="computer">
                  <option value="default">Organization default</option>
                  <option value="none">No computer</option>
                  <Errored fallback={null}>
                    <Show when={computers()}>
                      {(list) => <For each={list()}>{(each) => <option value={each.id}>{each.name} ({each.online ? "online" : "offline"})</option>}</For>}
                    </Show>
                  </Errored>
                </select>
              </label>
              <label class="check"><input ref={privately} type="checkbox" name="private" /> Private (only you can see it)</label>
            </div>
          </details>
        </div>
      </div>
      <Composer placeholder="Ask Trinity to do something…" onSend={send} autofocus />
    </div>
  );
}
