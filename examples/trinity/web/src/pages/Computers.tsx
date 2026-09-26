// Sandboxes and registered machines that run sessions' computer tools.
import { For, Show } from "solid-js";
import { client } from "../api.ts";
import { capitalize, relativeTime } from "../format.ts";
import { confirmAction, field, live, now, openDialog, slug } from "../ui.tsx";
import { Loading, Page, Table } from "./Page.tsx";

export const ComputersPage = () => (
  <Page title="Computers" actions={<button type="button" class="primary" onClick={newSandbox}>New sandbox</button>}>
    <Computers />
  </Page>
);

const newSandbox = () => openDialog({
  title: "New sandbox",
  body: () => (
    <>
      <p class="muted">A container that starts when a session needs it and stops after 30 idle minutes.</p>
      <label>Name<input name="name" required maxlength="200" placeholder="Build box" /></label>
      <label>Image<input name="image" required maxlength="512" placeholder="node:24" value="node:24" /></label>
    </>
  ),
  submitLabel: "Create",
  submit: (form) => client().mutate("computer.createSandbox", {
    id: slug(field(form, "name").value), name: field(form, "name").value.trim(), image: field(form, "image").value.trim(),
  }, { retry: true }),
});

function Computers() {
  const computers = live(() => client().subscribe("computer.list", null), "Watching computers");
  return (
    <>
      <section class="panel">
        <Show when={computers()} fallback={<Loading />}>
          {(list) => (
            <Show when={list().length > 0} fallback={<p class="empty">No computers yet. Create a sandbox or register your own machine.</p>}>
              <Table head={["Computer", "Kind", "State", "Owner"]}>
                <For each={list()} keyed={(each) => each.id}>
                  {(each) => (
                    <tr>
                      <td><strong>{each().name}</strong><div class="muted small">{each().id}</div></td>
                      <td><Show when={each().kind !== "local"} fallback="Local machine">Sandbox <span class="muted small">{each().image}</span></Show></td>
                      <td>
                        <Show
                          when={each().kind === "local"}
                          fallback={<span class={["badge", { "status-idle": each().state === "running", "status-working": each().state !== "running" && each().state !== "stopped" }]}>{capitalize(each().state)}</span>}
                        >
                          <span class={["badge", { "status-idle": each().online }]}>{each().online ? "Online" : "Offline"}</span>
                          <Show when={!each().online && each().lastSeenAt}>{(seen) => <> <span class="muted small">seen {relativeTime(seen(), now())}</span></>}</Show>
                        </Show>
                      </td>
                      <td class="muted">{each().owner}</td>
                      <td class="row-actions">
                        <button type="button" class="danger ghost" onClick={() => confirmAction("Remove computer?", `Sessions using ${each().name} can no longer run computer tools.`, "Remove",
                          () => client().mutate("computer.remove", { id: each().id }, { retry: true }))}>Remove</button>
                      </td>
                    </tr>
                  )}
                </For>
              </Table>
            </Show>
          )}
        </Show>
      </section>
      <section class="panel">
        <h2>Use your own machine</h2>
        <p class="muted">Register it with the command line, then run its tools there:</p>
        <pre class="code">{"bin/trinity computer register my-laptop \"My laptop\"\nbin/trinity local --computer my-laptop --workspace ~/src/project"}</pre>
      </section>
    </>
  );
}
