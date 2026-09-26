import type { Principal } from "@flower-js/sdk";
import { makeApp } from "../../app/app.ts";

/** Trusts credentials that are already a principal. The in-process engine cannot verify JWTs. */
export default makeApp({ authenticate: (_ctx, credentials) => credentials as unknown as Principal | null });
