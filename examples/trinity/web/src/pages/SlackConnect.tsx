// Where the Slack worker sends someone it does not know yet: link their Slack account to the signed-in member.
import { createSignal, Show } from "solid-js";
import { currentAuth, describe, linkSlack } from "../api.ts";
import { busy, route } from "../ui.tsx";
import { Page } from "./Page.tsx";

export const SlackConnectPage = () => <Page title="Connect Slack"><SlackConnect /></Page>;

function SlackConnect() {
  const org = currentAuth()?.claims.org;
  const [result, setResult] = createSignal<{ text: string; connected: boolean } | null>(null);
  const connect = (button: HTMLButtonElement, grant: string) => busy(button, async () => {
    try {
      const { workspace } = await linkSlack(grant);
      setResult({ text: `Connected to ${workspace}. Go back to Slack and mention Trinity again.`, connected: true });
    } catch (error) {
      setResult({ text: describe(error), connected: false });
    }
  });
  return (
    <Show
      when={route().query.get("grant")}
      fallback={<section class="panel"><h2>Nothing to connect</h2><p class="muted">Mention Trinity in Slack to get a link here.</p></section>}
    >
      {(grant) => (
        <section class="panel">
          <h2>Connect your Slack account</h2>
          <p>Messages you send Trinity in Slack, and buttons you press there, will act as you<Show when={org}> in <strong>{org}</strong></Show>.</p>
          <Show when={!result()?.connected}>
            <div class="actions"><button type="button" class="primary" onClick={(event) => void connect(event.currentTarget, grant())}>Connect</button></div>
          </Show>
          <p class="result muted" role="status">{result()?.text}</p>
        </section>
      )}
    </Show>
  );
}
