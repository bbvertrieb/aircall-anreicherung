/** Kern eines Laufs – identisch fuer Worker (Cron) und lokale Testbefehle. */
import type { AircallApi } from "./aircall"
import type { AirtableApi, ProtokollRecord, RecordUpdate } from "./airtable"
import { F, LIMITS } from "./config"
import { AirtableAbort, AuthError, Budget, BudgetExceeded, Clock, TransientError } from "./http"
import { AiContent, FetchedCall, Plan, expectedMainCall, finalize, lineMismatches, needsAi, precheck } from "./rules"
import { parseCallLines, summaryToText, transcriptToText } from "./text"

export interface RunOptions {
  mode: "dryrun" | "write"
  limit: number
  /** Nur diese Records statt der Auswahl per Formel (lokale Tests). */
  recordIds?: string[]
  /** Records mit bereits gesetztem Merge-Status nicht anfassen (Standard: true). */
  requireEmptyStatus?: boolean
  /** Wird im write-Modus nach dem Laden und VOR dem ersten Schreiben aufgerufen (Backup). */
  beforeWrite?: (records: ProtokollRecord[]) => Promise<void>
}

export interface RecordReport {
  recordId: string
  firma: string
  callIds: string[]
  numbers: string[]
  numberCheck: string
  plan: Plan
  uuid: string
  expectedMainCall: string | null
  uuidIsMain: "ja" | "nein" | "–"
  written: boolean
}

export interface RunStats {
  start: string
  end?: string
  mode: "dryrun" | "write"
  selected: number
  processed: number
  ok: number
  keinGespraech: number
  pruefen: number
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

export interface RunResult {
  stats: RunStats
  reports: RecordReport[]
}

export interface Deps {
  airtable: AirtableApi
  aircall: AircallApi
  budget: Budget
  clock: Clock
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v))

/** Ein Protokoll verarbeiten (nur lesen bei Aircall, nichts schreiben). */
export async function processRecord(
  record: ProtokollRecord,
  aircall: AircallApi,
  nowMs: number
): Promise<{ plan: Plan; fetched: FetchedCall[] }> {
  const parsed = parseCallLines(record.fields[F.AIRCALL_CALLS])
  if (parsed.lines.length === 0 || parsed.invalid.length > 0) {
    return { plan: precheck(record, parsed, [])!, fetched: [] }
  }
  const fetched: FetchedCall[] = []
  try {
    for (const line of parsed.lines) fetched.push({ line, call: await aircall.getCall(line.callId) })
    const early = precheck(record, parsed, fetched)
    if (early) return { plan: early, fetched }

    const ai = new Map<string, AiContent>()
    for (const f of fetched) {
      if (!f.call || !needsAi(f.call)) continue
      const tr = await aircall.getTranscription(f.line.callId)
      const su = await aircall.getSummary(f.line.callId)
      ai.set(f.line.callId, {
        transcript: tr ? transcriptToText(tr) : "",
        summary: su ? summaryToText(su) : "",
      })
    }
    return { plan: finalize(fetched, ai, nowMs), fetched }
  } catch (e) {
    if (e instanceof TransientError) {
      return { plan: { kind: "skip", reason: `transient: ${e.message}` }, fetched }
    }
    throw e
  }
}

function buildReport(record: ProtokollRecord, plan: Plan, fetched: FetchedCall[]): RecordReport {
  const parsed = parseCallLines(record.fields[F.AIRCALL_CALLS])
  const uuid = str(record.fields[F.CALL_UUID]).trim()
  const expected = fetched.length ? expectedMainCall(fetched) : null
  const mism = fetched.length ? lineMismatches(fetched) : []
  return {
    recordId: record.id,
    firma: str(record.fields[F.FIRMA]),
    callIds: parsed.lines.map((l) => l.callId),
    numbers: parsed.lines.map((l) => l.number),
    numberCheck: fetched.length === 0 ? "–" : mism.length ? mism.join(" | ") : "ok",
    plan,
    uuid,
    expectedMainCall: expected,
    uuidIsMain: !uuid || !expected ? "–" : uuid === expected ? "ja" : "nein",
    written: false,
  }
}

export async function runEnrichment(deps: Deps, opts: RunOptions): Promise<RunResult> {
  const { airtable, aircall, budget, clock } = deps
  const stats: RunStats = {
    start: new Date(clock.now()).toISOString(),
    mode: opts.mode,
    selected: 0,
    processed: 0,
    ok: 0,
    keinGespraech: 0,
    pruefen: 0,
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
  const reports: RecordReport[] = []
  const pending: { update: RecordUpdate; report: RecordReport }[] = []
  let airtableBroken = false

  const flush = async () => {
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    await airtable.updateRecords(batch.map((p) => p.update))
    for (const p of batch) p.report.written = true
    stats.written += batch.length
  }

  try {
    let records: ProtokollRecord[]
    if (opts.recordIds?.length) {
      records = []
      for (const id of opts.recordIds) {
        const r = await airtable.getRecord(id)
        if (r) records.push(r)
        else reports.push(buildReport({ id, createdTime: "", fields: {} }, { kind: "skip", reason: "Record nicht gefunden" }, []))
      }
    } else {
      records = await airtable.listCandidates(opts.limit)
    }
    stats.selected = records.length

    if (opts.mode === "write" && opts.beforeWrite) await opts.beforeWrite(records)

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!
      if (!budget.canStart(LIMITS.RECORD_START_RESERVE_MS, LIMITS.RECORD_START_RESERVE_REQUESTS)) {
        stats.abortReason = "Budget (Zeit/Subrequests) – Rest im nächsten Lauf"
        stats.notReached = records.length - i
        break
      }

      let plan: Plan
      let fetched: FetchedCall[] = []
      if ((opts.requireEmptyStatus ?? true) && str(record.fields[F.MERGE_STATUS]).trim()) {
        plan = { kind: "skip", reason: "Merge-Status bereits gesetzt" }
      } else if (!str(record.fields[F.AIRCALL_CALLS]).trim()) {
        plan = { kind: "skip", reason: "Aircall Calls leer" }
      } else {
        try {
          ;({ plan, fetched } = await processRecord(record, aircall, clock.now()))
        } catch (e) {
          if (e instanceof BudgetExceeded) {
            stats.abortReason = `Budget: ${e.message} – Rest im nächsten Lauf`
            stats.notReached = records.length - i
            break
          }
          throw e
        }
      }

      stats.processed++
      const report = buildReport(record, plan, fetched)
      reports.push(report)
      if (plan.kind === "skip") {
        stats.skipped++
        if (plan.reason.startsWith("transient")) stats.transientSkips++
        continue
      }
      if (plan.status === "ok") stats.ok++
      else if (plan.status === "kein Gespräch") stats.keinGespraech++
      else if (plan.status === "prüfen") stats.pruefen++
      else stats.fehler++

      if (opts.mode === "write") {
        pending.push({ update: { id: record.id, fields: plan.fields }, report })
        if (pending.length >= LIMITS.AIRTABLE_BATCH) await flush()
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
    stats.requestsAirtable = budget.counters.airtable
    stats.requestsAircall = budget.counters.aircall
    stats.rateLimitedAirtable = budget.counters.airtable429
    stats.rateLimitedAircall = budget.counters.aircall429
  }
  return { stats, reports }
}
