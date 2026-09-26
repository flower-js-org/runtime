// The sandbox has no clock, and Date and Intl are avoided there, so calendar math is done here on
// day numbers (days since 1970-01-01) with Howard Hinnant's civil-calendar algorithms.

export interface Cron {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: readonly number[];
  readonly months: readonly number[];
  /** 0 is Sunday; 7 in an expression becomes 0. */
  readonly weekdays: readonly number[];
  /** Whether the day-of-month field starts with `*`, steps included. As in Vixie cron, the day fields are ANDed when either does. */
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
}

export class CronError extends Error {
  readonly code = "INVALID_CRON";
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

interface Field {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** The last value `*` covers; values above it wrap (weekday 7 is 0). */
  readonly star: number;
  readonly names?: readonly string[];
}

const MINUTE: Field = { name: "minute", min: 0, max: 59, star: 59 };
const HOUR: Field = { name: "hour", min: 0, max: 23, star: 23 };
const DAY: Field = { name: "day of month", min: 1, max: 31, star: 31 };
const MONTH: Field = { name: "month", min: 1, max: 12, star: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] };
const WEEKDAY: Field = { name: "day of week", min: 0, max: 7, star: 6, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] };

const MACROS: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const NUMBER = /^\d+$/;

/**
 * Standard 5-field cron: minute hour day-of-month month day-of-week. Supports *, lists, ranges, steps
 * (*\/n, a-b/n, and a/n for a through the maximum), month and weekday names (JAN, MON; case-insensitive),
 * 7 as Sunday, and @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly. Rejects expressions that
 * can never match, such as 30 February.
 */
export function parseCron(expression: string): Cron {
  if (typeof expression !== "string") throw new CronError("A cron expression must be a string");
  const fail = (why: string): never => {
    throw new CronError(`Invalid cron expression "${expression}": ${why}`);
  };
  let text = expression.trim();
  if (text.startsWith("@")) text = MACROS[text.toLowerCase()] ?? fail(`unknown macro ${text}`);
  const parts = text === "" ? [] : text.split(/\s+/);
  if (parts.length !== 5) fail(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
  const [minutes = "", hours = "", days = "", months = "", weekdays = ""] = parts;
  const cron: Cron = {
    minutes: parseField(minutes, MINUTE, fail),
    hours: parseField(hours, HOUR, fail),
    days: parseField(days, DAY, fail),
    months: parseField(months, MONTH, fail),
    weekdays: parseField(weekdays, WEEKDAY, fail),
    anyDay: days.startsWith("*"),
    anyWeekday: weekdays.startsWith("*"),
  };
  compile(cron, `Cron expression "${expression}"`);
  return cron;
}

function parseField(text: string, field: Field, fail: (why: string) => never): number[] {
  const span = field.star - field.min + 1;
  const table = new Array<boolean>(field.star + 1).fill(false);
  const value = (token: string): number => {
    if (NUMBER.test(token)) {
      const n = Number(token);
      if (n < field.min || n > field.max) fail(`${field.name} ${token} is outside ${field.min}-${field.max}`);
      return n;
    }
    const index = field.names?.indexOf(token.toUpperCase()) ?? -1;
    if (index < 0) fail(`${field.name} "${token}" is not a number${field.names ? " or name" : ""}`);
    return index + field.min;
  };
  for (const item of text.split(",")) {
    if (item === "") fail(`empty ${field.name} list item`);
    const [range = "", stepText, extra] = item.split("/");
    if (extra !== undefined) fail(`${field.name} "${item}" has more than one step`);
    let step = 1;
    if (stepText !== undefined) {
      step = NUMBER.test(stepText) ? Number(stepText) : 0;
      if (step < 1 || step > span) fail(`${field.name} step in "${item}" must be 1-${span}`);
    }
    let lo = field.min;
    let hi = field.star;
    if (range !== "*") {
      const bounds = range.split("-");
      if (bounds.length > 2) fail(`${field.name} range "${range}" has more than two ends`);
      lo = value(bounds[0] ?? "");
      hi = bounds.length === 2 ? value(bounds[1] ?? "") : stepText === undefined ? lo : field.max;
      // Lets FRI-SUN mean Friday to Sunday although SUN is 0.
      if (field === WEEKDAY && hi === 0 && lo > 0) hi = 7;
      if (lo > hi) fail(`${field.name} range "${range}" runs backwards`);
    }
    for (let v = lo; v <= hi; v += step) table[v % (field.star + 1)] = true;
  }
  return indices(table);
}

function indices(table: readonly boolean[]): number[] {
  const out: number[] = [];
  table.forEach((set, i) => { if (set) out.push(i); });
  return out;
}

interface Tables {
  readonly minutes: boolean[];
  readonly hours: boolean[];
  readonly days: boolean[];
  readonly months: boolean[];
  readonly weekdays: boolean[];
  /** Day-of-month and day-of-week must both match; otherwise either does. */
  readonly both: boolean;
}

const LONGEST_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// Also validates schedules that did not come from parseCron, such as ones read back from storage.
function compile(cron: Cron, what: string): Tables {
  const table = (values: readonly number[], field: Field): boolean[] => {
    if (!Array.isArray(values)) throw new CronError(`${what} has no ${field.name} list`);
    const t = new Array<boolean>(field.star + 1).fill(false);
    for (const v of values) {
      if (!Number.isInteger(v) || v < field.min || v > field.max) throw new CronError(`${what} has ${field.name} ${v} outside ${field.min}-${field.max}`);
      t[v % (field.star + 1)] = true;
    }
    return t;
  };
  const t: Tables = {
    minutes: table(cron.minutes, MINUTE),
    hours: table(cron.hours, HOUR),
    days: table(cron.days, DAY),
    months: table(cron.months, MONTH),
    weekdays: table(cron.weekdays, WEEKDAY),
    both: cron.anyDay === true || cron.anyWeekday === true,
  };
  // The Gregorian calendar repeats every 400 years, a whole number of weeks, in which every date
  // (29 February included) falls on every weekday. So a schedule matches eventually unless one of
  // these fails, and nextRun's search always terminates.
  const firstDay = t.days.indexOf(true);
  const dated = firstDay > 0 && t.months.some((set, m) => set && (LONGEST_MONTH[m] ?? 0) >= firstDay);
  const weekly = t.weekdays.includes(true) && t.months.includes(true);
  const matches = t.minutes.includes(true) && t.hours.includes(true) && (t.both ? dated && weekly : dated || weekly);
  if (!matches) throw new CronError(`${what} never matches`);
  return t;
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;
const MAX_MS = 8.64e15;
const MAX_OFFSET_MINUTES = 18 * 60;

/**
 * The first minute strictly after `afterMs` (epoch ms) that matches, evaluated in a fixed UTC offset
 * (minutes east of UTC, e.g. 60 for UTC+1). Day-of-month and day-of-week combine with OR when both are
 * restricted, AND otherwise (Vixie cron). Returns epoch ms at second 0. Throws CronError for invalid
 * input or a schedule that never matches.
 */
export function nextRun(schedule: Cron | string, afterMs: number, offsetMinutes = 0): number {
  const t = compile(typeof schedule === "string" ? parseCron(schedule) : schedule, "Cron schedule");
  if (typeof afterMs !== "number" || !Number.isFinite(afterMs) || Math.abs(afterMs) > MAX_MS) throw new CronError(`Invalid time ${afterMs}`);
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
    throw new CronError(`UTC offset ${offsetMinutes} must be whole minutes within ±${MAX_OFFSET_MINUTES}`);
  }
  const start = Math.floor(afterMs / MINUTE_MS) + offsetMinutes + 1;
  let [y, m, d] = civilFromDays(Math.floor(start / MINUTES_PER_DAY));
  const minuteOfDay = start - daysFromCivil(y, m, d) * MINUTES_PER_DAY;
  let h = Math.floor(minuteOfDay / 60);
  let min = minuteOfDay % 60;
  // Unreachable for schedules compile accepts; it only guarantees termination.
  const lastYear = y + 401;
  while (y <= lastYear) {
    if (!t.months[m]) {
      if (m === 12) { y += 1; m = 1; } else m += 1;
      d = 1; h = 0; min = 0;
      continue;
    }
    const length = daysInMonth(y, m);
    const weekdayOfFirst = mod(daysFromCivil(y, m, 1) + 4, 7);
    let day = d;
    while (day <= length && !dayMatches(t, day, (weekdayOfFirst + day - 1) % 7)) day += 1;
    if (day > length) {
      if (m === 12) { y += 1; m = 1; } else m += 1;
      d = 1; h = 0; min = 0;
      continue;
    }
    if (day !== d) { d = day; h = 0; min = 0; }
    const hour = t.hours.indexOf(true, h);
    if (hour < 0) { d += 1; h = 0; min = 0; continue; }
    if (hour !== h) { h = hour; min = 0; }
    const minute = t.minutes.indexOf(true, min);
    if (minute < 0) { h += 1; min = 0; continue; }
    return (daysFromCivil(y, m, d) * MINUTES_PER_DAY + h * 60 + minute - offsetMinutes) * MINUTE_MS;
  }
  throw new CronError("Cron schedule never matches");
}

function dayMatches(t: Tables, day: number, weekday: number): boolean {
  const dom = t.days[day] === true;
  const dow = t.weekdays[weekday] === true;
  return t.both ? dom && dow : dom || dow;
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

function daysInMonth(y: number, m: number): number {
  if (m !== 2) return LONGEST_MONTH[m] ?? 31;
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
}

// https://howardhinnant.github.io/date_algorithms.html, with floor division for negative inputs.
function daysFromCivil(year: number, m: number, d: number): number {
  const y = m <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}
