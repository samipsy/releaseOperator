const JIRA_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{4}|Z)$/;
const NAIVE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** PCM / IPSY Jira profiles use Chicago; naive `YYYY-MM-DD HH:mm` is that wall clock. */
export const DEFAULT_PLANNED_TIME_ZONE = "America/Chicago";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function plannedTimeZone(env: NodeJS.Dict<string> = process.env): string {
  const raw = env.RELEASE_OPERATOR_TZ?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_PLANNED_TIME_ZONE;
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

/** Minutes east of UTC for `timeZone` at `utcInstant` (Chicago CDT = -300). */
function timeZoneOffsetMinutes(timeZone: string, utcInstant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcInstant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUtc - utcInstant.getTime()) / 60_000;
}

function wallClockToJira(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): string {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let offsetMin = timeZoneOffsetMinutes(timeZone, new Date(wallAsUtc));
  let utcMs = wallAsUtc - offsetMin * 60_000;
  offsetMin = timeZoneOffsetMinutes(timeZone, new Date(utcMs));
  utcMs = wallAsUtc - offsetMin * 60_000;
  offsetMin = timeZoneOffsetMinutes(timeZone, new Date(utcMs));
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.000${formatOffset(offsetMin)}`;
}

/** Jira datetime with numeric offset, e.g. 2026-10-02T20:00:00.000-0500 */
export function toJiraDateTime(raw: string, timeZone: string = plannedTimeZone()): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Planned time is empty.");
  const already = trimmed.match(JIRA_DATETIME);
  if (already) {
    const date = already[1];
    const time = already[2];
    const offset = already[3] === "Z" ? "+0000" : already[3];
    return `${date}T${time}.000${offset}`;
  }
  const naive = trimmed.match(NAIVE_DATETIME);
  if (!naive) {
    throw new Error(`Could not parse planned time "${raw}". Use e.g. 2026-10-02 20:00`);
  }
  return wallClockToJira(
    Number(naive[1]),
    Number(naive[2]),
    Number(naive[3]),
    Number(naive[4] ?? "0"),
    Number(naive[5] ?? "0"),
    Number(naive[6] ?? "0"),
    timeZone
  );
}

export function toJiraDate(raw: string, timeZone: string = plannedTimeZone()): string {
  return toJiraDateTime(raw, timeZone).slice(0, 10);
}
