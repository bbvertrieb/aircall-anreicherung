/** Airtable-IDs und feste Grenzen. Felder IMMER per ID ansprechen. */

export const AIRTABLE = {
  BASE_ID: "app8uGokICeSrE4FO",
  TABLE_ID: "tblO7sHXwS0KaisMD",
  API: "https://api.airtable.com/v0",
} as const

export const F = {
  // lesen
  CALL_UUID: "fld5oCajMBbEsE9iE",
  AIRCALL_CALLS: "fldRUhTT0wbMcHgLd",
  FIRMA: "fldb58YwRZBPVoGhF",
  CREATED: "fld9XAHgxnvJzX2GZ", // createdTime, nur fuer die Sortierung
  // schreiben (Worker ist einziger Schreiber)
  DURATION: "fldA7gEKLBkkxtDdT",
  AI_SUMMARY: "fldPOZh9OpWHecCGY",
  TRANSKRIPT: "fldvzUN5Y5SpfeX2c",
  MERGE_STATUS: "fldgQUEbRO9Sei434",
  MERGE_FEHLER: "fldtwennHb68U5b9h",
} as const

export const READ_FIELDS = [
  F.CALL_UUID,
  F.AIRCALL_CALLS,
  F.FIRMA,
  F.DURATION,
  F.AI_SUMMARY,
  F.TRANSKRIPT,
  F.MERGE_STATUS,
  F.MERGE_FEHLER,
] as const

export const WRITE_FIELDS = [
  F.DURATION,
  F.AI_SUMMARY,
  F.TRANSKRIPT,
  F.MERGE_STATUS,
  F.MERGE_FEHLER,
] as const

/** Exakte Optionsnamen des Single Select (kein typecast!). */
export type MergeStatus = "ok" | "kein Gespräch" | "prüfen" | "fehler"

/** Auswahl: Feldnamen in der Formel (filterByFormula kennt keine IDs). */
export const SELECT_FORMULA =
  "AND({Aircall Calls}!='', {Merge-Status}='', " +
  "IS_BEFORE(CREATED_TIME(), DATEADD(NOW(), -2, 'hours')))"

export const AIRCALL_API = "https://api.aircall.io/v1"

export const LIMITS = {
  AIRTABLE_MIN_INTERVAL_MS: 500, // max. 2 Requests/s
  AIRTABLE_429_WAIT_MS: 30_000,
  AIRTABLE_MAX_RETRIES: 3,
  AIRTABLE_BATCH: 10,
  AIRCALL_MIN_INTERVAL_MS: 1_200, // max. 50/min, Firmenlimit 60/min geteilt
  AIRCALL_429_DEFAULT_WAIT_MS: 60_000,
  AIRCALL_MAX_RETRIES: 3,
  HTTP_TIMEOUT_MS: 20_000,
  MAX_RUNTIME_MS: 12 * 60_000,
  MAX_SUBREQUESTS: 800,
  /** Neue Protokolle nur beginnen, wenn noch so viel Zeit/Requests uebrig sind. */
  RECORD_START_RESERVE_MS: 90_000,
  RECORD_START_RESERVE_REQUESTS: 40,
  /** Lese-Requests stoppen hier; der Rest bleibt fuer das Wegschreiben. */
  READ_RESERVE_MS: 60_000,
  READ_RESERVE_REQUESTS: 20,
  AI_MIN_DURATION_S: 30,
  AI_WAIT_HOURS: 12,
  MAX_TEXT_CHARS: 95_000,
} as const

export const TRUNCATE_SUFFIX = "\n[… gekürzt, vollständig in Aircall]"

export interface Env {
  AIRTABLE_TOKEN: string
  AIRCALL_API_ID: string
  AIRCALL_API_TOKEN: string
  ENABLED?: string
  MODE?: string
  MAX_RECORDS_PER_RUN?: string
  WINDOW_START?: string
  WINDOW_END?: string
  SKIP_WINDOWS?: string
}

export interface Settings {
  enabled: boolean
  mode: "dryrun" | "write"
  maxRecords: number
  windowStart: string
  windowEnd: string
  skipWindows: string
}

/** Sichere Defaults: alles, was nicht exakt passt, faellt auf "aus"/"dryrun". */
export function readSettings(env: Partial<Env>): Settings {
  const n = Number.parseInt(env.MAX_RECORDS_PER_RUN ?? "", 10)
  return {
    enabled: (env.ENABLED ?? "false").trim().toLowerCase() === "true",
    mode: (env.MODE ?? "dryrun").trim().toLowerCase() === "write" ? "write" : "dryrun",
    maxRecords: Number.isFinite(n) && n > 0 ? n : 150,
    windowStart: env.WINDOW_START?.trim() || "21:00",
    windowEnd: env.WINDOW_END?.trim() || "05:00",
    skipWindows: env.SKIP_WINDOWS?.trim() ?? "02:30-03:15",
  }
}
