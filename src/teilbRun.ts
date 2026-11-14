/** Teil B: Lauf ueber den Altbestand (Worker nach Teil A, und lokale Befehle). */
import type { AircallApi, AircallCall } from "./aircall"
import type { AirtableApi, AirtableQueryApi, ProtokollRecord, RecordUpdate } from "./airtable"
import { AIRTABLE, F, LIMITS } from "./config"
import { AirtableAbort, AuthError, Budget, BudgetExceeded, Clock, TransientError } from "./http"
import { AiContent, Plan, needsAi } from "./rules"
import { summaryToText, transcriptToText } from "./text"
import {
  Check,
  CheckId,
  RANGES,
  ROUTING,
  RoutingEntry,
  TeilBRange,
  duplicateFormula,
  isExactDuplicate,
  planB,
  precheckB,
  protocolNumbers,
  rangeOf,
  runChecks,
  selectFormula,
  FB,
} from "./teilbRules"

export interface TeilBDeps {
  airtable: AirtableApi & AirtableQueryApi
  aircall: AircallApi
  budget: Budget
  clock: Clock
}

export interface TeilBOptions {
  mode: "dryrun" | "write"
  limit: number
  ranges: TeilBRange[]
  /** Nur diese Records (lokal). */
  recordIds?: string[]
  /** Stichprobe statt der Reihe nach: Bereich in `sampleSlices` Zeitscheiben teilen (lokal). */
  sample?: boolean
  sampleSlices?: number
  /** Nur mit recordIds im write-Modus: vor dem ersten Schreiben (Backup). */
  beforeWrite?: (records: ProtokollRecord[]) => Promise<void>
}

export interface TeilBReport {
  recordId: string
  range: TeilBRange | "–"
  firma: string
  createdTime: string
  uuid: string
  numbers: string
  call: AircallCall | null | undefined
  checks: Check[]
  plan: Plan
  written: boolean
}

export interface TeilBStats {
  teil: "B"
  start: string
  end?: string
  mode: "dryrun" | "write"
  ranges: TeilBRange[]
  selected: number
  processed: number
  ok: number
  keinGespraech: number
  pruefen: number
  /** "prüfen" je Grund; ein Protokoll kann mehrere Gruende haben */
  pruefenGrund: Record<CheckId | "UUID" | "befuellt", number>
  fehler: number
  skipped: number
  transientSkips: number
  notReached: number
  written: number
  requestsAirtable: number
  requestsAircall: number
  rateLimitedAirtable: number
  rateLimitedAircall: number
  abortReason: string | null
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v))

/** CALLER ROUTING komplett laden: Number-ID -> Eintraege. */
export async function loadRouting(airtable: AirtableQueryApi): Promise<Map<string, RoutingEntry[]>> {
  const map = new Map<string, RoutingEntry[]>()
  let offset: string | undefined
  do {
    const page = await airtable.query(ROUTING.TABLE_ID, {
      fields: [ROUTING.NUMBER_ID, ROUTING.OPERATOR, ROUTING.NAME, ROUTING.ACTIVE],
      offset,
    })
    for (const r of page.records) {
      const id = str(r.fields[ROUTING.NUMBER_ID]).trim()
      if (!id) continue
      const ops = r.fields[ROUTING.OPERATOR]
      const e: RoutingEntry = {
        numberId: id,
        operators: Array.isArray(ops) ? ops.map(str) : [],
        name: str(r.fields[ROUTING.NAME]),
        active: typeof r.fields[ROUTING.ACTIVE] === "boolean" ? (r.fields[ROUTING.ACTIVE] as boolean) : null,
      }
      map.set(id, [...(map.get(id) ?? []), e])
    }
    offset = page.offset
  } while (offset)
  return map
}

async function findDuplicates(airtable: AirtableQueryApi, recordId: string, callId: string): Promise<string[]> {
  const out: string[] = []
  let offset: string | undefined
  do {
    const page = await airtable.query(AIRTABLE.TABLE_ID, {
      formula: duplicateFormula(recordId, callId),
      fields: [F.CALL_UUID, F.AIRCALL_CALLS],
      offset,
    })
    for (const r of page.records) if (r.id !== recordId && isExactDuplicate(r.fields, callId)) out.push(r.id)
    offset = page.offset
  } while (offset)
  return out
}

/** Ein Protokoll pruefen und planen (liest nur). */
export async function processRecordB(
  record: ProtokollRecord,
  range: TeilBRange,
  deps: Pick<TeilBDeps, "airtable" | "aircall">,
  routing: Map<string, RoutingEntry[]>,
  nowMs: number
): Promise<{ plan: Plan; call: AircallCall | null | undefined; checks: Check[] }> {
  const early = precheckB(record, range)
  if (early) return { plan: early, call: undefined, checks: [] }
  const uuid = str(record.fields[F.CALL_UUID]).trim()
  try {
    const call = await deps.aircall.getCall(uuid)
    if (!call) return { plan: planB(range, record, null, [], null, nowMs), call, checks: [] }
    const duplicates = await findDuplicates(deps.airtable, record.id, uuid)
    const checks = runChecks(record, call, routing, duplicates)
    let ai: AiContent | null = null
    if (checks.every((c) => c.ok) && needsAi(call)) {
      const tr = await deps.aircall.getTranscription(uuid)
      // B2 schreibt nur das Transkript -> Summary gar nicht erst abfragen
      const su = range === "B1" ? await deps.aircall.getSummary(uuid) : null
      ai = { transcript: tr ? transcriptToText(tr) : "", summary: su ? summaryToText(su) : "" }
    }
    return { plan: planB(range, record, call, checks, ai, nowMs), call, checks }
  } catch (e) {
    if (e instanceof TransientError) return { plan: { kind: "skip", reason: `transient: ${e.message}` }, call: undefined, checks: [] }
    throw e
  }
}

function emptyStats(mode: "dryrun" | "write", ranges: TeilBRange[], now: number): TeilBStats {
  return {
    teil: "B",
    start: new Date(now).toISOString(),
    mode,
    ranges,
    selected: 0,
    processed: 0,
    ok: 0,
    keinGespraech: 0,
    pruefen: 0,
    pruefenGrund: { UUID: 0, P1: 0, P2: 0, P3: 0, P4: 0, P5: 0, befuellt: 0 },
    fehler: 0,
    skipped: 0,
    transientSkips: 0,
    notReached: 0,
    written: 0,
    requestsAirtable: 0,
    requestsAircall: 0,
    rateLimitedAirtable: 0,
    rateLimitedAircall: 0,
    abortReason: null,
  }
}

/** Auswahl-Felder (per ID) fuer die Liste. */
const LIST_FIELDS = [
  F.CALL_UUID,
  F.AIRCALL_CALLS,
  F.FIRMA,
  F.CREATED,
  F.DURATION,
  F.AI_SUMMARY,
  F.TRANSKRIPT,
  F.MERGE_STATUS,
  F.MERGE_FEHLER,
  FB.AP_PHONE,
  FB.LEAD_PHONE,
  FB.OPERATOR,
]

export async function runTeilB(deps: TeilBDeps, opts: TeilBOptions): Promise<{ stats: TeilBStats; reports: TeilBReport[] }> {
  const { airtable, budget, clock } = deps
  const stats = emptyStats(opts.mode, opts.ranges, clock.now())
  // Im Worker teilt sich Teil B das Budget mit Teil A: nur die eigenen Requests zaehlen.
  const base = { ...budget.counters }
  const reports: TeilBReport[] = []
  const pending: { update: RecordUpdate; report: TeilBReport }[] = []
  let airtableBroken = false
  let routing: Map<string, RoutingEntry[]> | null = null

  const flush = async () => {
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    await airtable.updateRecords(batch.map((p) => p.update))
    for (const p of batch) p.report.written = true
    stats.written += batch.length
  }

  const report = (record: ProtokollRecord, range: TeilBRange | "–", plan: Plan, call?: AircallCall | null, checks: Check[] = []) => {
    const r: TeilBReport = {
      recordId: record.id,
      range,
      firma: [record.fields[F.FIRMA]].flat().map(str).join(", "),
      createdTime: record.createdTime,
      uuid: str(record.fields[F.CALL_UUID]).trim(),
      numbers: protocolNumbers(record).map((n) => `${n.source}: ${n.number}`).join(" | "),
      call,
      checks,
      plan,
      written: false,
    }
    reports.push(r)
    return r
  }

  /** `false` = Budget erreicht. */
  const handle = async (record: ProtokollRecord): Promise<boolean> => {
    if (!budget.canStart(LIMITS.RECORD_START_RESERVE_MS, LIMITS.RECORD_START_RESERVE_REQUESTS)) {
      stats.abortReason = "Budget (Zeit/Subrequests) – Rest im nächsten Lauf"
      return false
    }
    const range = rangeOf(record.createdTime)
    let plan: Plan
    let call: AircallCall | null | undefined
    let checks: Check[] = []
    // Teil A hat Vorrang und wird nie angefasst; nur Protokolle in aktiven Bereichen.
    if (str(record.fields[F.AIRCALL_CALLS]).trim()) plan = { kind: "skip", reason: "Aircall Calls gefüllt – gehört zu Teil A" }
    else if (str(record.fields[F.MERGE_STATUS]).trim()) plan = { kind: "skip", reason: "Merge-Status bereits gesetzt" }
    else if (!str(record.fields[F.CALL_UUID]).trim()) plan = { kind: "skip", reason: "Aircall Call UUID leer" }
    else if (!range) plan = { kind: "skip", reason: "Erstellzeit außerhalb B1/B2" }
    else if (!opts.recordIds?.length && !opts.ranges.includes(range)) plan = { kind: "skip", reason: `${range} nicht aktiv` }
    else {
      try {
        routing ??= await loadRouting(airtable)
        ;({ plan, call, checks } = await processRecordB(record, range, deps, routing, clock.now()))
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          stats.abortReason = `Budget: ${e.message} – Rest im nächsten Lauf`
          return false
        }
        throw e
      }
    }
    const rep = report(record, range ?? "–", plan, call, checks)
    if (plan.kind === "skip") {
      stats.skipped++
      if (plan.reason.startsWith("transient")) stats.transientSkips++
      return true
    }
    stats.processed++
    if (plan.status === "ok") stats.ok++
    else if (plan.status === "kein Gespräch") stats.keinGespraech++
    else if (plan.status === "fehler") stats.fehler++
    else {
      stats.pruefen++
      const failed = checks.filter((c) => !c.ok)
      for (const c of failed) stats.pruefenGrund[c.id]++
      if (!failed.length) {
        if (plan.notes.some((n) => n.includes("UUID ungültig"))) stats.pruefenGrund.UUID++
        else stats.pruefenGrund.befuellt++
      }
    }
    if (opts.mode === "write") {
      pending.push({ update: { id: record.id, fields: plan.fields }, report: rep })
      if (pending.length >= LIMITS.AIRTABLE_BATCH) await flush()
    }
    return true
  }

  /** Records einer Quelle der Reihe nach; `false` = beenden. */
  const consume = async (records: ProtokollRecord[]): Promise<boolean> => {
    for (let i = 0; i < records.length; i++) {
      if (stats.processed >= opts.limit || !(await handle(records[i]!))) {
        stats.notReached += records.length - i
        return false
      }
    }
    return true
  }

  try {
    if (opts.recordIds?.length) {
      const records: ProtokollRecord[] = []
      for (const id of opts.recordIds) {
        const r = await airtable.getRecord(id)
        if (r) records.push(r)
        else report({ id, createdTime: "", fields: {} }, "–", { kind: "skip", reason: "Record nicht gefunden" })
      }
      stats.selected = records.length
      if (opts.mode === "write" && opts.beforeWrite) await opts.beforeWrite(records)
      await consume(records)
    } else if (opts.sample) {
      // Stichprobe: jeden Bereich in Zeitscheiben teilen, je Scheibe die ersten n Records.
      const slices = opts.sampleSlices ?? 30
      const perRange = Math.ceil(opts.limit / Math.max(1, opts.ranges.length))
      const perSlice = Math.max(1, Math.ceil(perRange / slices))
      outer: for (const range of opts.ranges) {
        const a = Date.parse(RANGES[range].from)
        const b = Date.parse(RANGES[range].to)
        for (let s = 0; s < slices; s++) {
          const from = new Date(a + ((b - a) * s) / slices).toISOString()
          const to = new Date(a + ((b - a) * (s + 1)) / slices).toISOString()
          const page = await airtable.query(AIRTABLE.TABLE_ID, {
            formula: selectFormula(range, from, to),
            fields: LIST_FIELDS,
            pageSize: Math.min(100, perSlice),
            sortField: F.CREATED,
          })
          const recs = page.records.slice(0, perSlice)
          stats.selected += recs.length
          if (!(await consume(recs))) break outer
        }
      }
    } else {
      outer: for (const range of opts.ranges) {
        let offset: string | undefined
        do {
          const page = await airtable.query(AIRTABLE.TABLE_ID, {
            formula: selectFormula(range),
            fields: LIST_FIELDS,
            sortField: F.CREATED,
            offset,
          })
          stats.selected += page.records.length
          if (!(await consume(page.records))) break outer
          offset = page.offset
        } while (offset)
      }
    }
  } catch (e) {
    if (e instanceof AuthError) {
      stats.abortReason = e.message
      airtableBroken = e.service === "airtable"
    } else if (e instanceof AirtableAbort) {
      stats.abortReason = e.message
      airtableBroken = true
    } else if (e instanceof BudgetExceeded) {
      stats.abortReason = `Budget: ${e.message}`
    } else {
      stats.abortReason = `Unerwarteter Fehler: ${e instanceof Error ? e.message : String(e)}`
    }
  } finally {
    if (!airtableBroken && opts.mode === "write") {
      try {
        await flush()
      } catch (e) {
        stats.abortReason = [stats.abortReason, `Schreiben fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`]
          .filter(Boolean)
          .join(" | ")
      }
    }
    stats.end = new Date(clock.now()).toISOString()
    stats.requestsAirtable = budget.counters.airtable - base.airtable
    stats.requestsAircall = budget.counters.aircall - base.aircall
    stats.rateLimitedAirtable = budget.counters.airtable429 - base.airtable429
    stats.rateLimitedAircall = budget.counters.aircall429 - base.aircall429
  }
  return { stats, reports }
}
