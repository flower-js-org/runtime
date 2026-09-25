// Calendar arithmetic without Date, which deterministic callbacks cannot use.
// civil() is Howard Hinnant's civil_from_days.

interface CivilDate { year: number; month: number; day: number }

function civil(daysSinceEpoch: number): CivilDate {
  const z = daysSinceEpoch + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return {
    year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
    month,
    day: dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "YYYY-MM" in UTC. */
export function monthOf(epochMs: number): string {
  const { year, month } = civil(Math.floor(epochMs / 86_400_000));
  return `${year}-${pad(month)}`;
}

/** "YYYY-MM-DD HH:MM UTC". */
export function formatTime(epochMs: number): string {
  const { year, month, day } = civil(Math.floor(epochMs / 86_400_000));
  const minuteOfDay = Math.floor(epochMs / 60_000) % 1_440;
  return `${year}-${pad(month)}-${pad(day)} ${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)} UTC`;
}
