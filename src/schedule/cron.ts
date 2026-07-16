/**
 * src/schedule/cron.ts
 *
 * Minimal 5-field cron parser for the bot scheduler (docs/schedule.md).
 * Own implementation on purpose — iron rule 2 (minimal deps): a full cron
 * library pulls in far more surface than the scheduler needs.
 *
 * Supported syntax per field (minute hour day-of-month month day-of-week):
 *   `*`         any value
 *   `5`         exact value
 *   `1-5`       inclusive range
 *   `*​/15`      step over the full range
 *   `10-40/10`  step over a range
 *   `1,3,5-7`   comma list of any of the above
 *
 * Semantics follow vixie cron:
 *   - day-of-week: 0–7 where both 0 and 7 mean Sunday.
 *   - when BOTH day-of-month and day-of-week are restricted (not `*`), a date
 *     matches if EITHER matches.
 *   - evaluation is in the HOST's local timezone (the bridge machine's clock —
 *     same clock launchd/systemd timers would use).
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the raw field was `*` — needed for the vixie dom/dow OR rule. */
  domIsWildcard: boolean;
  dowIsWildcard: boolean;
}

const FIELD_RANGES: ReadonlyArray<{ name: string; min: number; max: number }> = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
];

function parseField(raw: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const stepMatch = /^([^/]+)(?:\/(\d+))?$/.exec(part.trim());
    if (!stepMatch) throw new Error(`cron: invalid ${name} field "${part}"`);
    const base = stepMatch[1]!;
    const step = stepMatch[2] !== undefined ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron: invalid step in ${name} field "${part}"`);
    }

    let lo: number;
    let hi: number;
    if (base === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      // A bare number with a step ("3/5") is treated as "3-max/5", matching
      // vixie cron; without a step it is the single value.
      hi = stepMatch[2] !== undefined ? max : lo;
    } else {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
      if (!rangeMatch) throw new Error(`cron: invalid ${name} field "${part}"`);
      lo = Number(rangeMatch[1]);
      hi = Number(rangeMatch[2]);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron: ${name} value out of range in "${part}" (${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`cron: empty ${name} field`);
  return out;
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields (minute hour dom month dow), got ${fields.length} in "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = FIELD_RANGES.map((r, i) =>
    parseField(fields[i]!, r.min, r.max, r.name),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  // Normalize Sunday: 7 → 0 so matching only ever checks getDay() (0–6).
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minute,
    hour,
    dayOfMonth: dom,
    month,
    dayOfWeek: dow,
    domIsWildcard: fields[2] === "*",
    dowIsWildcard: fields[4] === "*",
  };
}

/** True when the given LOCAL-time instant (truncated to the minute) matches. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.minute.has(at.getMinutes())) return false;
  if (!spec.hour.has(at.getHours())) return false;
  if (!spec.month.has(at.getMonth() + 1)) return false;
  const domMatch = spec.dayOfMonth.has(at.getDate());
  const dowMatch = spec.dayOfWeek.has(at.getDay());
  // vixie rule: both restricted → OR; otherwise the restricted one (or both
  // wildcards → always true) must match.
  if (!spec.domIsWildcard && !spec.dowIsWildcard) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/** Max lookahead when computing the next fire — beyond this the expr is
 *  considered unsatisfiable (e.g. Feb 30). ~2 years covers every real expr. */
const MAX_LOOKAHEAD_MINUTES = 2 * 366 * 24 * 60;

/**
 * The next instant STRICTLY AFTER `from` that matches, in host-local time,
 * with seconds/millis zeroed. Returns null when no match exists within the
 * lookahead window (unsatisfiable expression).
 */
export function nextFireAfter(spec: CronSpec, from: Date): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i++) {
    cursor.setTime(cursor.getTime() + 60_000);
    // Fast-skip whole non-matching hours/days to keep worst-case cheap.
    if (!spec.month.has(cursor.getMonth() + 1)) {
      // jump to the 1st of next month, 00:00
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      cursor.setTime(cursor.getTime() - 60_000); // loop's +1min re-lands on 00:00
      continue;
    }
    if (!spec.hour.has(cursor.getHours())) {
      cursor.setMinutes(59, 0, 0); // loop's +1min moves to the next hour
      continue;
    }
    if (cronMatches(spec, cursor)) return new Date(cursor.getTime());
  }
  return null;
}
