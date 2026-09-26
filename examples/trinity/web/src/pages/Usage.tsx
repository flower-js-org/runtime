// This month's spending (or an earlier month's) against the organization's budget.
import { createSignal, Show } from "solid-js";
import { client } from "../api.ts";
import { formatDollars, formatTokens } from "../format.ts";
import { live } from "../ui.tsx";
import { Loading, Page } from "./Page.tsx";

export const UsagePage = () => <Page title="Usage"><Usage /></Page>;

function Usage() {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = createSignal(thisMonth);
  const usage = live(() => client().subscribe("org.usage", { month: month() }), "Watching usage");
  return (
    <section class="panel">
      <div class="panel-head">
        <h2>Spending</h2>
        <label class="inline">Month <input type="month" name="month" value={month()} max={thisMonth} onChange={(event) => { if (event.currentTarget.value) setMonth(event.currentTarget.value); }} /></label>
      </div>
      <div class="usage">
        <Show when={usage()} fallback={<Loading />}>
          {(value) => {
            const budget = () => value().budgetNanos;
            const share = () => (budget() ? Math.min(1, value().costNanos / budget()!) : 0);
            const over = () => budget() !== null && value().costNanos >= budget()!;
            return (
              <>
                <div class="stats">
                  <div class="stat">
                    <div class="stat-label">Spent</div><div class="stat-value">{formatDollars(value().costNanos)}</div>
                    <div class="muted small">{budget() === null ? "No monthly budget" : `of ${formatDollars(budget())} budget`}</div>
                  </div>
                  <div class="stat"><div class="stat-label">Input tokens</div><div class="stat-value">{formatTokens(value().input)}</div></div>
                  <div class="stat"><div class="stat-label">Output tokens</div><div class="stat-value">{formatTokens(value().output)}</div></div>
                  <div class="stat"><div class="stat-label">Completions</div><div class="stat-value">{(value().completions ?? 0).toLocaleString()}</div></div>
                </div>
                <Show when={budget() !== null}>
                  <div class={["meter", { over: over(), near: !over() && share() > 0.8 }]} role="meter" aria-label="Budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(share() * 100)}>
                    <div class="meter-fill" style={{ width: `${(share() * 100).toFixed(1)}%` }} />
                  </div>
                  <p class="muted small">{Math.round(share() * 100)}% of the {value().month} budget{over() ? " — new turns are refused until the budget is raised or the month ends" : ""}.</p>
                </Show>
              </>
            );
          }}
        </Show>
      </div>
    </section>
  );
}
