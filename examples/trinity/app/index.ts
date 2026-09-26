import { makeApp } from "./app.ts";

/** The application's type, for typed clients. Deployments build their own entry with an authenticator (see scripts/deploy.ts). */
const app = makeApp({ authenticate: null });
export default app;
