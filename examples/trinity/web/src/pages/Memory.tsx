// The files agents read and write, per organization or per person.
import { createSignal, For, refresh, Show } from "solid-js";
import { client } from "../api.ts";
import { dateTime, formatBytes, relativeTime } from "../format.ts";
import { busy, confirmAction, field, load, now, submitter, toast } from "../ui.tsx";
import { Loading, Page } from "./Page.tsx";

export const MemoryPage = () => <Page title="Memory"><Memory /></Page>;

type Scope = "org" | "user";
interface MemoryFile { path: string; content: string; updatedAt: number; updatedBy: string }

function Memory() {
  const [scope, setScope] = createSignal<Scope>("org");
  const [selected, setSelected] = createSignal<string | null>(null);
  // A fresh object per opened file, so the keyed editor below starts over with its contents.
  const [editing, setEditing] = createSignal<{ file: MemoryFile | null }>({ file: null });
  const files = load(() => client().query("memory.list", { scope: scope() }, { retry: true }), "Loading memory");

  const choose = (next: Scope) => {
    setScope(next);
    setSelected(null);
    setEditing({ file: null });
  };
  const open = async (path: string) => {
    setSelected(path);
    const file = await busy(null, async () => (await client().query("memory.read", { path, scope: scope() }, { retry: true })).value, "Opening");
    if (file) setEditing({ file });
    else if (file === null) toast(`${path} no longer exists.`);
  };
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const path = field(form, "path").value.trim();
    const saved = await busy(submitter(event), () => client().mutate("memory.write", { path, content: field(form, "content").value, scope: scope() }, { retry: true }));
    if (saved === undefined) return;
    toast(`Saved ${path}.`, "info");
    void refresh(files);
    await open(path);
  };

  return (
    <section class="panel memory">
      <div class="panel-head">
        <div class="segmented" role="group" aria-label="Memory scope">
          <button type="button" aria-pressed={String(scope() === "org") as "true" | "false"} onClick={() => choose("org")}>Organization</button>
          <button type="button" aria-pressed={String(scope() === "user") as "true" | "false"} onClick={() => choose("user")}>Personal</button>
        </div>
        <button type="button" onClick={() => { setSelected(null); setEditing({ file: null }); }}>New file</button>
      </div>
      <p class="muted small">Agents read and write these files. Each scope's <code>index.md</code> is shown to the agent at the start of every turn.</p>
      <div class="memory-layout">
        <nav class="memory-files" aria-label="Memory files">
          <Show when={files()} fallback={<Loading />}>
            {(list) => (
              <For each={list()} keyed={(file) => file.path} fallback={<p class="empty">No files in this scope.</p>}>
                {(file) => (
                  <button type="button" class="memory-file" aria-current={String(file().path === selected()) as "true" | "false"} onClick={() => void open(file().path)}>
                    <span class="memory-path">{file().path}</span>
                    <span class="muted small">{formatBytes(file().size)} · {relativeTime(file().updatedAt, now())}</span>
                  </button>
                )}
              </For>
            )}
          </Show>
        </nav>
        <div class="memory-editor">
          <Show when={editing()} keyed>
            {({ file }) => (
              <form class="memory-form" onSubmit={save}>
                <label>Path
                  <input name="path" value={file?.path ?? ""} placeholder="notes.md" required maxlength="256" readonly={file !== null}
                    pattern="[A-Za-z0-9][A-Za-z0-9._\-]*(/[A-Za-z0-9][A-Za-z0-9._\-]*)*" />
                </label>
                <label>Content<textarea name="content" rows="18" maxlength="100000" spellcheck>{file?.content ?? ""}</textarea></label>
                <Show when={file}>{(shown) => <p class="muted small">Updated {dateTime(shown().updatedAt)} by {shown().updatedBy}</p>}</Show>
                <div class="actions">
                  <Show when={file}>
                    {(shown) => (
                      <button type="button" class="danger ghost" onClick={() => confirmAction("Delete memory file?", `Agents will no longer see ${shown().path}.`, "Delete", async () => {
                        await client().mutate("memory.delete", { path: shown().path, scope: scope() }, { retry: true });
                        setSelected(null);
                        setEditing({ file: null });
                        await refresh(files);
                      })}>Delete</button>
                    )}
                  </Show>
                  <button type="submit" class="primary">Save</button>
                </div>
              </form>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}
