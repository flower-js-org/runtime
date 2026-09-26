// The frame of an organization page. Pages load inside the boundary, so Retry loads them again.
import { Errored } from "solid-js";
import type { JSX } from "@solidjs/web";
import { documentTitle, Topbar } from "../ui.tsx";

export function Page(props: { title: string; actions?: JSX.Element; children: JSX.Element }) {
  documentTitle(() => props.title);
  return (
    <div class="view page-view">
      <Topbar title={props.title} actions={props.actions} />
      <div class="page">
        <div class="page-inner">
          <Errored fallback={(_, retry) => <><p class="muted">Could not load this page.</p><button type="button" onClick={retry}>Retry</button></>}>
            {props.children}
          </Errored>
        </div>
      </div>
    </div>
  );
}

export const Loading = () => <p class="muted">Loading…</p>;

/** A table in its horizontal scroller, with a visually hidden header for the actions column. */
export function Table(props: { head: string[]; actions?: boolean; children: JSX.Element }) {
  return (
    <div class="table-wrap">
      <table class="table">
        <thead><tr>{props.head.map((each) => <th>{each}</th>)}{props.actions === false ? null : <th><span class="sr-only">Actions</span></th>}</tr></thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}
