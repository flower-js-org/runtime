// Prompts that run as new sessions on a schedule.
import { For, refresh, Show } from "solid-js";
import { client } from "../api.ts";
import { dateTime, relativeTime } from "../format.ts";
import { busy, confirmAction, field, load, ModelOptions, navigate, now, openDialog, sessionHref, slug } from "../ui.tsx";
import { Loading, Page, Table } from "./Page.tsx";
import { ComputerOptions } from "./Settings.tsx";

interface Automation {
  id: string; name: string; schedule: string; offsetMinutes: number; prompt: string; model: string | null; computer: string | null; enabled: boolean;
  nextAt: number | null; lastRunAt: number | null; lastSession: string | null;
}

// Pages load inside Page's boundary, so the button that opens the editor reaches it through this.
let editAutomation: (automation?: Automation) => void = () => {};

export const AutomationsPage = () => (
  <Page title="Automations" actions={<button type="button" class="primary" onClick={() => editAutomation()}>New automation</button>}>
    <Automations />
  </Page>
);

function Automations() {
  const automations = load(() => client().query("automation.list", null, { retry: true }), "Loading automations");
  const computers = load(() => client().query("computer.list", null, { retry: true }), "Loading automations");

  const save = (automation: Pick<Automation, "id" | "name" | "schedule" | "offsetMinutes" | "prompt" | "model" | "computer" | "enabled">) => {
    const { id, name, schedule, offsetMinutes, prompt, model, computer, enabled } = automation;
    return client().mutate("automation.set", { id, name, schedule, offsetMinutes, prompt, model, computer, enabled }, { retry: true });
  };

  editAutomation = (automation) => {
    const offset = -new Date().getTimezoneOffset();
    openDialog({
      title: automation ? `Edit ${automation.name}` : "New automation",
      body: () => (
        <>
          <label>Name<input name="name" value={automation?.name ?? ""} required maxlength="200" placeholder="Daily report" /></label>
          <label>Schedule
            <input name="schedule" value={automation?.schedule ?? ""} required maxlength="200" placeholder="0 9 * * 1-5" />
            <span class="hint">Five-field cron (minute hour day month weekday), or @daily, @hourly and the like.</span>
          </label>
          <label>UTC offset (minutes)
            <input name="offset" type="number" min="-1080" max="1080" step="1" value={automation?.offsetMinutes ?? offset} />
            <span class="hint">The schedule's time zone; yours is {offset}.</span>
          </label>
          <label>Prompt<textarea name="prompt" rows="5" required>{automation?.prompt ?? ""}</textarea></label>
          <label>Model<input name="model" list="models" value={automation?.model ?? ""} placeholder="Organization default" /></label>
          <ModelOptions />
          <label>Computer<select name="computer"><ComputerOptions computers={computers() ?? []} selected={automation?.computer ?? null} /></select></label>
          <label class="check"><input type="checkbox" name="enabled" checked={automation === undefined || automation.enabled} /> Enabled</label>
        </>
      ),
      submitLabel: automation ? "Save" : "Create",
      submit: async (form) => {
        await save({
          id: automation?.id ?? slug(field(form, "name").value),
          name: field(form, "name").value.trim(),
          schedule: field(form, "schedule").value.trim(),
          offsetMinutes: Number(field(form, "offset").value || 0),
          prompt: field(form, "prompt").value,
          model: field(form, "model").value.trim() || null,
          computer: field(form, "computer").value || null,
          enabled: field(form, "enabled").checked,
        });
        await refresh(automations);
      },
    });
  };

  return (
    <Show when={automations()} fallback={<Loading />}>
      {(list) => (
        <section class="panel">
          <Show when={list().length > 0} fallback={<p class="empty">No automations. They run a prompt as a new session on a schedule.</p>}>
            <Table head={["Automation", "Schedule", "Next run", "Last run"]}>
              <For each={list()} keyed={(each) => each.id}>
                {(each) => (
                  <tr>
                    <td><strong>{each().name}</strong><div class="muted small clamp">{each().prompt}</div></td>
                    <td>
                      <code>{each().schedule}</code>
                      <div class="muted small">{each().offsetMinutes ? `UTC${each().offsetMinutes > 0 ? "+" : ""}${each().offsetMinutes / 60}h` : "UTC"}</div>
                    </td>
                    <td><Show when={each().enabled} fallback={<span class="badge">Paused</span>}>{dateTime(each().nextAt)}</Show></td>
                    <td>
                      <Show when={each().lastSession} fallback={<span class="muted">Never</span>}>
                        {(session) => <a href={sessionHref(session())}>{relativeTime(each().lastRunAt, now())}</a>}
                      </Show>
                    </td>
                    <td class="row-actions">
                      <button type="button" class="ghost" onClick={async (event) => {
                        const result = await busy(event.currentTarget, () => client().mutate("automation.run", { id: each().id }, { retry: true }), "Running");
                        if (result) navigate(sessionHref(result.value.session));
                      }}>Run now</button>
                      <button type="button" class="ghost" onClick={async (event) => {
                        if (await busy(event.currentTarget, () => save({ ...each(), enabled: !each().enabled }), "Saving")) await refresh(automations);
                      }}>{each().enabled ? "Pause" : "Resume"}</button>
                      <button type="button" class="ghost" onClick={() => editAutomation(each())}>Edit</button>
                      <button type="button" class="danger ghost" onClick={() => confirmAction("Delete automation?", `${each().name} stops running.`, "Delete", async () => {
                        await client().mutate("automation.delete", { id: each().id }, { retry: true });
                        await refresh(automations);
                      })}>Delete</button>
                    </td>
                  </tr>
                )}
              </For>
            </Table>
          </Show>
        </section>
      )}
    </Show>
  );
}
