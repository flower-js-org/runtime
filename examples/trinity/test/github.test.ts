import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryError, splitText } from "../workers/delivery.ts";
import { parseGithubEvent, postGithubComment, verifyGithubSignature } from "../workers/github.ts";

function fakeFetch(...replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("unexpected request");
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function rejection(promise: Promise<unknown>): Promise<DeliveryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DeliveryError, `expected a DeliveryError, got ${error}`);
    return error;
  }
  assert.fail("expected a rejection");
}

test("signatures match GitHub's documented example and nothing tampered", () => {
  const secret = "It's a Secret to Everybody";
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.equal(verifyGithubSignature(secret, "Hello, World!", signature), true);
  assert.equal(verifyGithubSignature(secret, "Hello, World?", signature), false);
  assert.equal(verifyGithubSignature("another secret", "Hello, World!", signature), false);
  assert.equal(verifyGithubSignature(secret, "Hello, World!", signature.replace(/7$/, "8")), false);
  assert.equal(verifyGithubSignature(secret, "Hello, World!", signature.slice(0, -1)), false);
  assert.equal(verifyGithubSignature(secret, "Hello, World!", signature.replace("sha256=", "sha1=")), false);
  assert.equal(verifyGithubSignature(secret, "Hello, World!", undefined), false);
  assert.equal(verifyGithubSignature(secret, "Hello, World!", ""), false);
});

const repository = { id: 1296269, name: "hello", full_name: "octo/hello", private: false, owner: { login: "octo", type: "Organization" } };
const user = (login: string, type = "User") => ({ login, id: 583231, type });

function issueComment(body: string, login = "mona", action = "created") {
  return {
    action,
    issue: {
      id: 1, number: 42, title: "Crash on start", state: "open", user: user("octo-dev"), body: "It crashes.",
      html_url: "https://github.com/octo/hello/issues/42",
    },
    comment: {
      id: 2001, node_id: "IC_kwDO", body, user: user(login, login.endsWith("[bot]") ? "Bot" : "User"),
      html_url: "https://github.com/octo/hello/issues/42#issuecomment-2001", created_at: "2026-09-25T10:00:00Z",
    },
    repository,
    sender: user(login),
  };
}

test("an issue comment mentioning the bot starts or continues the issue's thread", () => {
  assert.deepEqual(parseGithubEvent("issue_comment", issueComment("@Trinity can you look at the stack trace?"), "trinity"), {
    repo: "octo/hello",
    number: 42,
    thread: "octo/hello#42",
    messageId: "issue_comment:2001",
    user: "mona",
    text: "can you look at the stack trace?",
    url: "https://github.com/octo/hello/issues/42#issuecomment-2001",
  });
});

test("an app's slug[bot] login matches mentions of the slug, and its own comments are ignored", () => {
  assert.equal(parseGithubEvent("issue_comment", issueComment("Thanks, @trinity!"), "trinity[bot]")?.text, "Thanks, !");
  assert.equal(parseGithubEvent("issue_comment", issueComment("@trinity done", "trinity[bot]"), "trinity[bot]"), null);
  assert.equal(parseGithubEvent("issue_comment", issueComment("@trinity done", "Trinity"), "trinity"), null);
});

test("comments that do not address the bot are ignored", () => {
  const parse = (text: string) => parseGithubEvent("issue_comment", issueComment(text), "trinity");
  assert.equal(parse("Looks good to me"), null);
  assert.equal(parse("ping @trinity-dev"), null);
  assert.equal(parse("mail me at ops@trinity.dev"), null);
  assert.equal(parse("Run `@trinity fix` to ask it"), null);
  assert.equal(parse("```\n@trinity fix\n```"), null);
  assert.equal(parse("> @trinity fix this\n\nI disagree."), null);
  assert.equal(parseGithubEvent("issue_comment", issueComment("@trinity fix", "mona", "edited"), "trinity"), null);
  assert.equal(parseGithubEvent("issue_comment", { action: "created" }, "trinity"), null);
  assert.equal(parseGithubEvent("star", { action: "created", repository }, "trinity"), null);
  assert.equal(parseGithubEvent("issue_comment", null, "trinity"), null);
});

test("a new issue brings its title and body", () => {
  const payload = {
    action: "opened",
    issue: {
      id: 3050, number: 7, title: "Flaky test in CI", body: "@trinity please investigate\nIt fails one run in ten.",
      user: user("mona"), html_url: "https://github.com/octo/hello/issues/7", labels: [], state: "open",
    },
    repository,
    sender: user("mona"),
  };
  assert.deepEqual(parseGithubEvent("issues", payload, "trinity"), {
    repo: "octo/hello",
    number: 7,
    thread: "octo/hello#7",
    messageId: "issues:3050",
    user: "mona",
    text: "Flaky test in CI\n\nplease investigate\nIt fails one run in ten.",
    url: "https://github.com/octo/hello/issues/7",
  });
  const titleOnly = { ...payload, issue: { ...payload.issue, title: "@trinity bump deps", body: null } };
  assert.equal(parseGithubEvent("issues", titleOnly, "trinity")?.text, "bump deps");
  assert.equal(parseGithubEvent("issues", { ...payload, action: "closed" }, "trinity"), null);
});

test("a review comment joins its pull request's thread", () => {
  const payload = {
    action: "created",
    comment: {
      id: 9001, pull_request_review_id: 77, path: "src/main.ts", line: 12, diff_hunk: "@@ -1,3 +1,4 @@",
      body: "Why this change, @trinity?", user: user("mona"), html_url: "https://github.com/octo/hello/pull/8#discussion_r9001",
    },
    pull_request: { id: 555, number: 8, title: "Refactor", user: user("octo-dev"), html_url: "https://github.com/octo/hello/pull/8" },
    repository,
    sender: user("mona"),
  };
  assert.deepEqual(parseGithubEvent("pull_request_review_comment", payload, "trinity"), {
    repo: "octo/hello",
    number: 8,
    thread: "octo/hello#8",
    messageId: "pull_request_review_comment:9001",
    user: "mona",
    text: "Why this change, ?",
    url: "https://github.com/octo/hello/pull/8#discussion_r9001",
  });
});

test("a comment is posted with GitHub's REST headers", async () => {
  const { calls, fetchImpl } = fakeFetch(json({ id: 11, html_url: "https://github.com/octo/hello/issues/42#issuecomment-11" }, 201));
  const posted = await postGithubComment({ token: "ghs_test", repo: "octo/hello", number: 42, body: "Fixed in #43." }, fetchImpl);
  assert.deepEqual(posted, { id: 11, url: "https://github.com/octo/hello/issues/42#issuecomment-11" });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, "https://api.github.com/repos/octo/hello/issues/42/comments");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer ghs_test");
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(init.body)), { body: "Fixed in #43." });
});

test("a long comment is split at line breaks and posted in order to the configured API", async () => {
  const line = "x".repeat(999);
  const body = Array.from({ length: 100 }, () => line).join("\n");
  const { calls, fetchImpl } = fakeFetch(json({ id: 1, html_url: "u1" }, 201), json({ id: 2, html_url: "u2" }, 201));
  const posted = await postGithubComment({ token: "t", repo: "octo/hello", number: 1, body, apiUrl: "https://ghe.example.com/api/v3/" }, fetchImpl);
  assert.deepEqual(posted, { id: 1, url: "u1" });
  assert.deepEqual(calls.map((call) => call.url), Array(2).fill("https://ghe.example.com/api/v3/repos/octo/hello/issues/1/comments"));
  const pieces = calls.map((call) => JSON.parse(String(call.init.body)).body as string);
  assert.ok(pieces.every((piece) => piece.length <= 65_536));
  assert.equal(pieces.join("\n"), body);
  assert.ok(pieces[0]!.endsWith(line) && pieces[1]!.startsWith(line));
});

test("failures are retryable only when asking again can succeed", async () => {
  const post = (reply: Response | Error, signal?: AbortSignal) =>
    postGithubComment({ token: "t", repo: "octo/hello", number: 1, body: "hi", ...(signal ? { signal } : {}) }, fakeFetch(reply).fetchImpl);

  const invalid = await rejection(post(json({ message: "Validation Failed" }, 422)));
  assert.equal(invalid.retryable, false);
  assert.match(invalid.message, /422: Validation Failed/);
  assert.equal((await rejection(post(json({ message: "Not Found" }, 404)))).retryable, false);
  assert.equal((await rejection(post(json({ message: "Must have admin rights" }, 403)))).retryable, false);

  const unavailable = await rejection(post(new Response("<html>", { status: 502 })));
  assert.equal(unavailable.retryable, true);
  assert.equal(unavailable.retryAfterMs, undefined);

  const secondary = await rejection(post(json({ message: "You have exceeded a secondary rate limit" }, 403, { "retry-after": "60" })));
  assert.deepEqual([secondary.retryable, secondary.retryAfterMs], [true, 60_000]);

  const reset = Math.floor(Date.now() / 1_000) + 120;
  const primary = await rejection(post(json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })));
  assert.equal(primary.retryable, true);
  assert.ok(primary.retryAfterMs! > 100_000 && primary.retryAfterMs! <= 120_000);

  const network = await rejection(post(new TypeError("fetch failed")));
  assert.equal(network.retryable, true);
  assert.ok(network.cause instanceof TypeError);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(post(new DOMException("aborted", "AbortError"), controller.signal), { name: "AbortError" });
});

test("text splits prefer line breaks, then spaces, and never cut a surrogate pair", () => {
  assert.deepEqual(splitText("short", 10), ["short"]);
  assert.deepEqual(splitText("aaaa\nbbbb cccc", 10), ["aaaa\nbbbb", "cccc"]);
  assert.deepEqual(splitText("aaaaaaaa\nbb", 10), ["aaaaaaaa", "bb"]);
  assert.deepEqual(splitText("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
  assert.deepEqual(splitText("abcd😀efgh", 5), ["abcd", "😀efg", "h"]);
});
