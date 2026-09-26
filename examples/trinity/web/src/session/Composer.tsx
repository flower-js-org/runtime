// The message box under a session: text, attachments (picked, pasted or dropped), steer and halt.
import { createSignal, For, onSettled, Show, untrack } from "solid-js";
import type { Attachment } from "../../../app/model.ts";
import { upload } from "../api.ts";
import { formatBytes } from "../format.ts";
import { AttachIcon, busy, report, toast } from "../ui.tsx";

export interface Message { text: string; attachments: Attachment[]; steer: boolean }

interface FileEntry { id: number; name: string; size: number; status: "uploading" | "ready" | "error"; attachment: Attachment | null }

let fileIds = 0;

export function Composer(props: {
  placeholder?: string;
  /** Resolves false when the message was not sent, to restore the draft. */
  onSend: (message: Message) => Promise<boolean>;
  onHalt?: () => Promise<unknown>;
  /** A turn is running: steering applies to it. */
  working?: boolean;
  /** A turn exists: halting applies to it. */
  turn?: boolean;
  draft?: string;
  autofocus?: boolean;
}) {
  let form!: HTMLFormElement;
  let textarea!: HTMLTextAreaElement;
  let picker!: HTMLInputElement;
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  const [steer, setSteer] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [dropping, setDropping] = createSignal(false);

  const autosize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  };
  onSettled(() => {
    const draft = untrack(() => props.draft);
    if (draft) {
      textarea.value = draft;
      autosize();
    }
    if (untrack(() => props.autofocus)) textarea.focus();
  });

  const update = (id: number, change: Partial<FileEntry>) => setFiles((list) => list.map((each) => (each.id === id ? { ...each, ...change } : each)));
  const add = (chosen: File[]) => {
    for (const file of chosen) {
      const entry: FileEntry = { id: ++fileIds, name: file.name || "pasted file", size: file.size, status: "uploading", attachment: null };
      setFiles((list) => [...list, entry]);
      upload(file).then((attachment) => update(entry.id, { status: "ready", attachment }), (error) => {
        update(entry.id, { status: "error" });
        report(error, `Uploading ${entry.name}`);
      });
    }
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const chosen = files();
    if (chosen.some((file) => file.status === "uploading")) return toast("Wait for the uploads to finish.", "info");
    const attachments = chosen.flatMap((file) => (file.status === "ready" && file.attachment ? [file.attachment] : []));
    let text = textarea.value.trim();
    if (text === "" && attachments.length === 0) return;
    if (text === "") text = `Attached: ${attachments.map((each) => each.name).join(", ")}`;
    const draft = textarea.value;
    textarea.value = "";
    setFiles([]);
    autosize();
    setSending(true);
    const sent = await props.onSend({ text, attachments, steer: props.working === true && steer() });
    setSending(false);
    if (sent) setSteer(false);
    else if (textarea.value === "") {
      textarea.value = draft;
      setFiles(chosen);
      autosize();
    }
  };

  return (
    <form
      ref={form}
      class={["composer", { dropping: dropping() }]}
      aria-label="Send a message"
      onSubmit={submit}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false);
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        add([...event.dataTransfer.files]);
      }}
    >
      <Show when={files().length > 0}>
        <div class="composer-files">
          <For each={files()} keyed={(file) => file.id}>
            {(file) => (
              <span class={["file-chip", file().status]}>
                <span class="file-name">{file().name}</span>
                <span class="file-size">{file().status === "uploading" ? "Uploading…" : file().status === "error" ? "Failed" : formatBytes(file().size)}</span>
                <button type="button" class="icon-button" aria-label={`Remove ${file().name}`} onClick={() => setFiles((list) => list.filter((each) => each.id !== file().id))}>×</button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="composer-box">
        <label class="sr-only" for="composer-text">Message</label>
        <textarea
          ref={textarea}
          id="composer-text"
          rows="1"
          placeholder={props.placeholder ?? "Message Trinity…"}
          onInput={autosize}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              form.requestSubmit();
            }
          }}
          onPaste={(event) => {
            if (!event.clipboardData?.files.length) return;
            event.preventDefault();
            add([...event.clipboardData.files]);
          }}
        />
        <div class="composer-bar">
          <button type="button" class="icon-button" aria-label="Attach files" title="Attach files" onClick={() => picker.click()}><AttachIcon /></button>
          <input ref={picker} type="file" multiple hidden tabindex="-1" onChange={() => {
            add([...picker.files ?? []]);
            picker.value = "";
          }} />
          <Show when={props.working}>
            <label class="steer" title="Deliver at the next step of the running turn instead of after it">
              <input type="checkbox" checked={steer()} onChange={(event) => setSteer(event.currentTarget.checked)} /> Steer
            </label>
          </Show>
          <span class="composer-hint">Enter to send · Shift+Enter for a new line</span>
          <Show when={props.turn && props.onHalt}>
            {(halt) => <button type="button" class="danger" data-role="halt" onClick={(event) => void busy(event.currentTarget, halt(), "Halting")}>Halt</button>}
          </Show>
          <button type="submit" class="primary" data-role="send" disabled={sending()}>Send</button>
        </div>
      </div>
    </form>
  );
}
