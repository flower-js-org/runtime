import { DeliveryError, deliver, failure } from "./delivery.ts";

const METER_EVENTS = "https://api.stripe.com/v1/billing/meter_events";

/**
 * Report usage to a Stripe meter. Stripe refuses an identifier it has already accepted, for at
 * least a day, so resending one whose response was lost succeeds without counting twice.
 */
export async function reportMeterEvent(
  options: { apiKey: string; eventName: string; customer: string; value: number; identifier: string; timestamp: number; signal?: AbortSignal },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!Number.isSafeInteger(options.value)) throw new DeliveryError(`Meter event values are integers, not ${options.value}.`, { retryable: false });
  const form = new URLSearchParams({
    "event_name": options.eventName,
    "identifier": options.identifier,
    "timestamp": String(Math.floor(options.timestamp / 1_000)),
    "payload[stripe_customer_id]": options.customer,
    "payload[value]": String(options.value),
  });
  // No Idempotency-Key: Stripe would replay a saved 500 to every retry for a day. The identifier deduplicates.
  const { response, body } = await deliver(fetchImpl, METER_EVENTS, {
    method: "POST",
    headers: { "Authorization": `Bearer ${options.apiKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: options.signal,
  });
  if (response.ok) return;
  const error = (body as Record<string, any> | undefined)?.error;
  if (response.status === 400 && duplicate(error)) return;
  const message = typeof error?.message === "string" ? error.message : response.statusText;
  // Stripe says whether a retry can succeed when it knows better than the status code.
  const advice = response.headers.get("stripe-should-retry");
  throw failure(response, `Stripe responded ${response.status}: ${message}`, advice === null ? undefined : advice === "true");
}

function duplicate(error: Record<string, any> | undefined): boolean {
  if (error?.code === "resource_already_exists") return true;
  const message = typeof error?.message === "string" ? error.message : "";
  return (error?.param === "identifier" || /identifier/i.test(message)) && /already|duplicate/i.test(message);
}
