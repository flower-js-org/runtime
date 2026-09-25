import assert from "node:assert/strict";
import { test } from "node:test";
import { type Cron, CronError, nextRun, parseCron } from "../app/cron.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const next = (expression: string, after: string, offset?: number) => iso(nextRun(expression, at(after), offset));
const invalid = (error: unknown) => error instanceof CronError && error.code === "INVALID_CRON";
const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

function runs(expression: string, after: string, count: number, offset?: number): string[] {
  const out: string[] = [];
  let t = at(after);
  for (let i = 0; i < count; i++) out.push(iso(t = nextRun(expression, t, offset)));
  return out;
}

test("parses lists, ranges, steps and names", () => {
  assert.deepEqual(parseCron("*/15 0-6/2 1,15 JAN-mar,Dec mon-FRI"), {
    minutes: [0, 15, 30, 45],
    hours: [0, 2, 4, 6],
    days: [1, 15],
    months: [1, 2, 3, 12],
    weekdays: [1, 2, 3, 4, 5],
    anyDay: false,
    anyWeekday: false,
  });
  assert.deepEqual(parseCron("  * * * * *  "), {
    minutes: range(0, 59), hours: range(0, 23), days: range(1, 31), months: range(1, 12), weekdays: range(0, 6), anyDay: true, anyWeekday: true,
  });
  assert.deepEqual(parseCron("5,1,3-4,1 10/5 */10 2/3 *").minutes, [1, 3, 4, 5]);
  assert.deepEqual(parseCron("0 10/5 */10 2/3 *").hours, [10, 15, 20]);
  assert.deepEqual(parseCron("0 0 */10 2/3 *").days, [1, 11, 21, 31]);
  assert.deepEqual(parseCron("0 0 * 2/3 *").months, [2, 5, 8, 11]);
  assert.equal(parseCron("0 0 */2 * 1").anyDay, true);
});

test("7 is Sunday", () => {
  assert.deepEqual(parseCron("0 0 * * 7").weekdays, [0]);
  assert.deepEqual(parseCron("0 0 * * 0,7").weekdays, [0]);
  assert.deepEqual(parseCron("0 0 * * 5-7").weekdays, [0, 5, 6]);
  assert.deepEqual(parseCron("0 0 * * FRI-SUN").weekdays, [0, 5, 6]);
  assert.deepEqual(parseCron("0 0 * * sun").weekdays, [0]);
  assert.deepEqual(parseCron("0 0 * * */2").weekdays, [0, 2, 4, 6]);
  assert.equal(next("0 12 * * 7", "2026-09-25T00:00:00Z"), "2026-09-27T12:00:00.000Z");
});

test("expands macros", () => {
  assert.deepEqual(parseCron("@yearly"), parseCron("0 0 1 1 *"));
  assert.deepEqual(parseCron("@annually"), parseCron("0 0 1 1 *"));
  assert.deepEqual(parseCron("@monthly"), parseCron("0 0 1 * *"));
  assert.deepEqual(parseCron("@weekly"), parseCron("0 0 * * 0"));
  assert.deepEqual(parseCron("@daily"), parseCron("0 0 * * *"));
  assert.deepEqual(parseCron(" @MIDNIGHT "), parseCron("0 0 * * *"));
  assert.deepEqual(parseCron("@hourly"), parseCron("0 * * * *"));
  assert.equal(next("@weekly", "2026-09-25T10:00:00Z"), "2026-09-27T00:00:00.000Z");
  for (const bad of ["@reboot", "@daily 5", "@", "@every 5m"]) assert.throws(() => parseCron(bad), invalid, bad);
});

test("rejects malformed expressions", () => {
  const cases = [
    "", "   ", "* * * *", "* * * * * *", "* * * * * * *",
    "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 0 *", "* * * 13 *", "* * * * 8",
    "*/0 * * * *", "*/ * * * *", "*/x * * * *", "1-5/0 * * * *", "*/61 * * * *", "* */25 * * *", "* * * * */8", "*/1.5 * * * *",
    "*/2/3 * * * *", "5-1 * * * *", "1-2-3 * * * *", "1- * * * *", "-1 * * * *", "1,,2 * * * *", "1, * * * *",
    "a * * * *", "1.5 * * * *", "+1 * * * *", "0x1 * * * *", "JAN * * * *", "* * MON * *", "* * * * JAN",
    "* * * JANUARY *", "* * * * MONDAY", "* * * * SAT-MON", "** * * * *", "? * * * *",
  ];
  for (const expression of cases) assert.throws(() => parseCron(expression), invalid, JSON.stringify(expression));
  assert.throws(() => parseCron("61 * * * *"), /minute 61 is outside 0-59/);
  assert.throws(() => parseCron("* * * *"), /expected 5 fields.*got 4/);
  assert.throws(() => parseCron(42 as unknown as string), invalid);
  assert.throws(() => nextRun("* * * *", 0), invalid);
});

test("rejects schedules that never match", () => {
  for (const expression of ["0 0 30 2 *", "0 0 31 2 *", "0 0 31 4,6,9,11 *", "0 0 30,31 feb *", "0 0 31 2-2 *"]) {
    assert.throws(() => parseCron(expression), (e: unknown) => invalid(e) && /never matches/.test((e as Error).message), expression);
    assert.throws(() => nextRun(expression, 0), invalid, expression);
  }
  // Still satisfiable: 29 February, a day some chosen month has, or OR with a weekday.
  assert.equal(next("0 0 29,30 2 *", "2026-09-25T00:00:00Z"), "2028-02-29T00:00:00.000Z");
  assert.equal(next("0 0 31 4,5 *", "2026-09-25T00:00:00Z"), "2027-05-31T00:00:00.000Z");
  assert.equal(next("0 0 30 2 MON", "2026-09-25T00:00:00Z"), "2027-02-01T00:00:00.000Z");
  const impossible: Cron = { ...parseCron("0 0 1 2 *"), days: [30] };
  assert.throws(() => nextRun(impossible, 0), invalid);
  assert.throws(() => nextRun({ ...impossible, days: [] }, 0), invalid);
  assert.throws(() => nextRun({ ...parseCron("* * * * *"), minutes: [60] }, 0), invalid);
});

test("returns the first matching minute strictly after the given time", () => {
  assert.equal(next("*/15 * * * *", "2026-09-25T10:07:30Z"), "2026-09-25T10:15:00.000Z");
  assert.equal(next("*/15 * * * *", "2026-09-25T10:14:59.999Z"), "2026-09-25T10:15:00.000Z");
  assert.equal(next("*/15 * * * *", "2026-09-25T10:15:00Z"), "2026-09-25T10:30:00.000Z");
  assert.equal(next("* * * * *", "2026-09-25T10:15:00.001Z"), "2026-09-25T10:16:00.000Z");
  assert.equal(next("0 9-17 * * MON-FRI", "2026-09-25T17:00:00Z"), "2026-09-28T09:00:00.000Z");
  assert.equal(next("30 4 1 * *", "2026-09-25T10:00:00Z"), "2026-10-01T04:30:00.000Z");
  assert.equal(next("0 0 1 1 *", "1969-06-01T00:00:00Z"), "1970-01-01T00:00:00.000Z");
  assert.equal(next("0 0 * * *", "1969-12-31T23:59:59.999Z"), "1970-01-01T00:00:00.000Z");
});

test("combines day of month and day of week with OR only when both are restricted", () => {
  assert.deepEqual(runs("0 9 13 * FRI", "2026-09-25T10:00:00Z", 4), [
    "2026-10-02T09:00:00.000Z", "2026-10-09T09:00:00.000Z", "2026-10-13T09:00:00.000Z", "2026-10-16T09:00:00.000Z",
  ]);
  assert.equal(next("0 9 13 * *", "2026-09-25T10:00:00Z"), "2026-10-13T09:00:00.000Z");
  assert.equal(next("0 9 * * FRI", "2026-09-25T10:00:00Z"), "2026-10-02T09:00:00.000Z");
  // As in Vixie cron, a field starting with * counts as unrestricted even with a step: odd-day Fridays.
  assert.deepEqual(runs("0 9 */2 * FRI", "2026-09-25T10:00:00Z", 2), ["2026-10-09T09:00:00.000Z", "2026-10-23T09:00:00.000Z"]);
  assert.equal(next("0 9 1-31 * FRI", "2026-09-25T10:00:00Z"), "2026-09-26T09:00:00.000Z");
});

test("handles month ends and leap years", () => {
  assert.deepEqual(runs("0 0 31 * *", "2026-09-25T00:00:00Z", 3), ["2026-10-31T00:00:00.000Z", "2026-12-31T00:00:00.000Z", "2027-01-31T00:00:00.000Z"]);
  assert.deepEqual(runs("0 0 29 2 *", "2026-01-01T00:00:00Z", 2), ["2028-02-29T00:00:00.000Z", "2032-02-29T00:00:00.000Z"]);
  assert.equal(next("0 0 29 2 *", "1999-01-01T00:00:00Z"), "2000-02-29T00:00:00.000Z");
  assert.equal(next("0 0 29 2 *", "2096-03-01T00:00:00Z"), "2104-02-29T00:00:00.000Z");
  assert.equal(next("0 0 28-31 2 *", "2100-02-28T00:00:00Z"), "2101-02-28T00:00:00.000Z");
  assert.equal(next("59 23 * 2 *", "2028-02-28T23:59:00Z"), "2028-02-29T23:59:00.000Z");
  assert.equal(next("0 12 30 * *", "2027-01-30T12:00:00Z"), "2027-03-30T12:00:00.000Z");
});

test("evaluates in a fixed UTC offset across day boundaries", () => {
  assert.equal(next("0 9 * * *", "2026-09-25T00:00:00Z", 60), "2026-09-25T08:00:00.000Z");
  assert.equal(next("0 9 * * *", "2026-09-25T08:00:00Z", 60), "2026-09-26T08:00:00.000Z");
  // Monday 01:30 at UTC+10 is Sunday 15:30 UTC.
  assert.equal(next("30 1 * * MON", "2026-09-25T00:00:00Z", 600), "2026-09-27T15:30:00.000Z");
  // 23:00 on the 24th at UTC-5 is 04:00 UTC on the 25th.
  assert.equal(next("0 23 24 * *", "2026-09-25T03:59:00Z", -300), "2026-09-25T04:00:00.000Z");
  assert.equal(next("0 23 24 * *", "2026-09-25T04:00:00Z", -300), "2026-10-25T04:00:00.000Z");
  assert.equal(next("0 0 * * *", "2026-09-25T12:00:00Z", 330), "2026-09-25T18:30:00.000Z");
  assert.equal(next("15 0 1 * *", "2026-09-25T00:00:00Z", 345), "2026-09-30T18:30:00.000Z");
  for (const offset of [0.5, 1081, -1081, Number.NaN]) assert.throws(() => nextRun("* * * * *", 0, offset), invalid, String(offset));
  for (const time of [Number.NaN, Number.POSITIVE_INFINITY, 1e16]) assert.throws(() => nextRun("* * * * *", time), invalid, String(time));
});

test("rolls over into the next year", () => {
  assert.equal(next("0 0 1 1 *", "2026-12-31T23:59:00Z"), "2027-01-01T00:00:00.000Z");
  assert.equal(next("59 23 31 12 *", "2026-12-31T23:59:00Z"), "2027-12-31T23:59:00.000Z");
  assert.equal(next("0 0 1 1 *", "2026-12-31T23:30:00Z", -60), "2027-01-01T01:00:00.000Z");
  assert.equal(next("0 0 1 1 *", "2026-12-31T22:30:00Z", 120), "2027-12-31T22:00:00.000Z");
  assert.equal(next("* * * * *", "2026-12-31T23:59:30Z"), "2027-01-01T00:00:00.000Z");
});

test("accepts a parsed schedule that went through JSON", () => {
  const stored = JSON.parse(JSON.stringify(parseCron("*/20 8-18 * * mon-fri"))) as Cron;
  assert.equal(iso(nextRun(stored, at("2026-09-25T18:40:30Z"))), "2026-09-28T08:00:00.000Z");
});

test("agrees with a minute-by-minute search", () => {
  const matches = (cron: Cron, ms: number, offset: number) => {
    const d = new Date(ms + offset * 60_000);
    const dom = cron.days.includes(d.getUTCDate());
    const dow = cron.weekdays.includes(d.getUTCDay());
    return cron.minutes.includes(d.getUTCMinutes()) && cron.hours.includes(d.getUTCHours()) && cron.months.includes(d.getUTCMonth() + 1) &&
      (cron.anyDay || cron.anyWeekday ? dom && dow : dom || dow);
  };
  const brute = (cron: Cron, after: number, offset: number) => {
    let t = Math.floor(after / 60_000) * 60_000 + 60_000;
    while (!matches(cron, t, offset)) t += 60_000;
    return t;
  };
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const expressions = ["*/7 */5 * * *", "0 9 13 * FRI", "15 3 */2 * 1-5", "0 12 1,15 * *", "0 0 * * 0", "0 0 31 * *", "5 4 * 2 *", "0 0 */3 * */2", "45 23 28-31 * *", "0 6 1 */4 SAT"];
  for (const expression of expressions) {
    const cron = parseCron(expression);
    for (const offset of [0, 60, -330, 765]) {
      for (let i = 0; i < 4; i++) {
        const after = at("2023-01-01T00:00:00Z") + Math.floor(random() * 8 * 365 * 86_400_000) + Math.floor(random() * 60_000);
        assert.equal(iso(nextRun(cron, after, offset)), iso(brute(cron, after, offset)), `${expression} at ${iso(after)} offset ${offset}`);
      }
    }
  }
});
