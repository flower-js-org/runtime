import { render } from "@solidjs/web";
import { App } from "./App.tsx";
import { toast } from "./ui.tsx";
import "./style.css";

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { name?: string; message?: string } | undefined;
  if (reason?.name === "AbortError") return event.preventDefault();
  toast(reason?.message ?? String(event.reason));
});

const root = document.getElementById("root")!;
root.replaceChildren();
render(() => <App />, root);
