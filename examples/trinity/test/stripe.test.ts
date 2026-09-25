import assert from "node:assert/strict";
import { test } from "node:test";
import { DeliveryError } from "../workers/delivery.ts";
import { reportMeterEvent } from "../workers/stripe.ts";

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

const stripeError = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) =>
  json({ error: { type: "invalid_request_error", ...error } }, status, { "request-id": "req_123", ...headers });

async function rejection(promise: Promise<unknown>): Promise<DeliveryError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DeliveryError, `expected a DeliveryError, got ${error}`);
    return error;
  }
  assert.fail("expected a rejection");
}

const event = {
  apiKey: "sk_test_123",
  eventName: "trinity_tokens",
  customer: "cus_NciAYcXfLnqBoz",
  value: 1234,
  identifier: "session-1:step-7",
  timestamp: 1_758_800_000_999,
};

test("a meter event is form-encoded with its timestamp in seconds", async () => {
  const { calls, fetchImpl } = fakeFetch(json({
    object: "billing.meter_event", event_name: "trinity_tokens", identifier: "session-1:step-7", livemode: false,
    payload: { stripe_customer_id: "cus_NciAYcXfLnqBoz", value: "1234" }, timestamp: 1758800000, created: 1758800001,
  }));
  await reportMeterEvent(event, fetchImpl);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, "https://api.stripe.com/v1/billing/meter_events");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer sk_test_123");
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(headers.get("idempotency-key"), null);
  assert.match(String(init.body), /payload%5Bvalue%5D=1234/);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init.body))), {
    "event_name": "trinity_tokens",
    "identifier": "session-1:step-7",
    "timestamp": "1758800000",
    "payload[stripe_customer_id]": "cus_NciAYcXfLnqBoz",
    "payload[value]": "1234",
  });
});

test("an identifier Stripe has already accepted counts as reported", async () => {
  await reportMeterEvent(event, fakeFetch(stripeError(400, {
    code: "resource_already_exists", message: "An event with identifier session-1:step-7 already exists.", param: "identifier",
  })).fetchImpl);
  await reportMeterEvent(event, fakeFetch(stripeError(400, { message: "This identifier has already been used for a meter event." })).fetchImpl);
});

test("other refusals are final and say why", async () => {
  const unknown = await rejection(reportMeterEvent(event, fakeFetch(stripeError(400, {
    code: "resource_missing", message: "No active meter found for event_name trinity_tokens", param: "event_name",
  })).fetchImpl));
  assert.equal(unknown.retryable, false);
  assert.match(unknown.message, /400: No active meter found/);
  assert.equal((await rejection(reportMeterEvent(event, fakeFetch(stripeError(401, { message: "Invalid API Key provided" })).fetchImpl))).retryable, false);
});

test("rate limits, server errors and network failures are retryable unless Stripe says otherwise", async () => {
  const report = (reply: Response | Error) => rejection(reportMeterEvent(event, fakeFetch(reply).fetchImpl));

  const limited = await report(stripeError(429, { type: "rate_limit_error", code: "rate_limit", message: "Too many requests" }));
  assert.deepEqual([limited.retryable, limited.retryAfterMs], [true, undefined]);
  const failed = await report(stripeError(500, { type: "api_error", message: "Something went wrong" }, { "retry-after": "2" }));
  assert.deepEqual([failed.retryable, failed.retryAfterMs], [true, 2_000]);
  assert.equal((await report(new Response("", { status: 503 }))).retryable, true);
  assert.equal((await report(new TypeError("fetch failed"))).retryable, true);

  assert.equal((await report(stripeError(500, { type: "api_error", message: "No" }, { "stripe-should-retry": "false" }))).retryable, false);
  assert.equal((await report(stripeError(409, { code: "lock_timeout", message: "Conflict" }, { "stripe-should-retry": "true" }))).retryable, true);
});

test("a fractional value is refused before anything is sent", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const error = await rejection(reportMeterEvent({ ...event, value: 1.5 }, fetchImpl));
  assert.equal(error.retryable, false);
  assert.equal(calls.length, 0);
});
