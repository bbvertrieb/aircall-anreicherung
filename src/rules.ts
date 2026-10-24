/** Status-Regeln je Protokoll – reine Funktionen, ohne I/O. */
import type { AircallCall } from "./aircall"
import type { ProtokollRecord } from "./airtable"
import { F, LIMITS, MergeStatus } from "./config"
import { samePhone } from "./phone"
import { CallLine, ParsedCalls, TextBlock, mergeBlocks, truncate } from "./text"

export interface FetchedCall {
  line: CallLine
  /** null = 404 bei Aircall */
  call: AircallCall | null
}

export interface AiContent {
  transcript: string
  summary: string
}

export interface WritePlan {
  kind: "write"
  status: MergeStatus
  /** Nur diese Felder werden geschrieben (Field-IDs). */
  fields: Record<string, unknown>
  notes: string[]
  duration?: number
  summary?: string
  transcript?: string
}

export interface SkipPlan {
  kind: "skip"
  reason: string
}

export type Plan = WritePlan | SkipPlan

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v))

function statusOnly(status: MergeStatus, notes: string[]): WritePlan {
  return {
    kind: "write",
    status,
    notes,
    fields: { [F.MERGE_STATUS]: status, [F.MERGE_FEHLER]: notes.join("\n") || null },
  }
}

export function isAnswered(c: AircallCall): boolean {
  return c.answered_at != null && c.answered_at !== 0
}

/** AI-Endpunkte nur bei beantwortet UND duration >= 30 s abfragen. */
export function needsAi(c: AircallCall): boolean {
  return isAnswered(c) && (c.duration ?? 0) >= LIMITS.AI_MIN_DURATION_S
}

/** Nummern-/Richtungspruefung je Zeile; leeres Array = alles passt. */
export function lineMismatches(fetched: FetchedCall[]): string[] {
  const out: string[] = []
  for (const { line, call } of fetched) {
    if (!call) continue
    const problems: string[] = []
    if (!samePhone(line.number, call.raw_digits)) {
      problems.push(`Nummer passt nicht (gewählt "${line.number}", Aircall raw_digits "${call.raw_digits ?? ""}")`)
    }
    if (call.direction !== "outbound") problems.push(`direction "${call.direction ?? ""}" statt outbound`)
    if (problems.length) out.push(`Call ${line.callId}: ${problems.join("; ")}`)
  }
  return out
}

/**
 * Pruefungen, die vor den AI-Abfragen entscheiden (Schritte 2, 3 und 404).
 * `null` = weiter mit der Verarbeitung.
 */
export function precheck(record: ProtokollRecord, parsed: ParsedCalls, fetched: FetchedCall[]): WritePlan | null {
  if (parsed.lines.length === 0 || parsed.invalid.length > 0) {
    const notes = parsed.invalid.map((l) => `Zeile nicht lesbar: "${l}"`)
    if (parsed.lines.length === 0) notes.push("Keine Call-ID in \"Aircall Calls\"")
    return statusOnly("prüfen", notes)
  }
  const missing = fetched.filter((f) => f.call === null)
  if (missing.length) {
    return statusOnly(
      "fehler",
      missing.map((f) => `Call ${f.line.callId} bei Aircall nicht gefunden (404)`)
    )
  }
  const mism = lineMismatches(fetched)
  if (mism.length) return statusOnly("prüfen", mism)
  if (str(record.fields[F.AI_SUMMARY]).trim() || str(record.fields[F.TRANSKRIPT]).trim()) {
    return statusOnly("prüfen", ["Felder bereits befüllt – nicht überschrieben"])
  }
  return null
}

export function totalDuration(fetched: FetchedCall[]): number {
  return fetched.reduce((s, f) => s + (f.call?.duration ?? 0), 0)
}

/** Ende des Calls in ms (fuer die 12-h-Wartezeit auf Aircall-AI). */
function callEndMs(c: AircallCall): number {
  const end = c.ended_at ?? (c.started_at ?? 0) + (c.duration ?? 0)
  return end * 1000
}

/**
 * Schritte 4–9, nachdem precheck() durch ist und die AI-Inhalte der
 * relevanten Calls (needsAi) geladen sind.
 */
export function finalize(fetched: FetchedCall[], ai: Map<string, AiContent>, nowMs: number): Plan {
  const calls = fetched.map((f) => ({ line: f.line, call: f.call as AircallCall }))
  const duration = totalDuration(fetched)

  if (!calls.some((c) => isAnswered(c.call))) {
    return {
      kind: "write",
      status: "kein Gespräch",
      notes: [],
      duration,
      fields: { [F.DURATION]: duration, [F.MERGE_STATUS]: "kein Gespräch", [F.MERGE_FEHLER]: null },
    }
  }

  const notes: string[] = []
  const summaryBlocks: TextBlock[] = []
  const transcriptBlocks: TextBlock[] = []
  const withoutAi: string[] = []

  for (const { line, call } of calls) {
    if (!needsAi(call)) continue
    const content = ai.get(line.callId) ?? { transcript: "", summary: "" }
    if (!content.transcript && !content.summary) {
      if (nowMs - callEndMs(call) < LIMITS.AI_WAIT_HOURS * 3600_000) {
        return { kind: "skip", reason: `Call ${line.callId}: noch kein Transkript/Summary (jünger als ${LIMITS.AI_WAIT_HOURS} h)` }
      }
      withoutAi.push(line.callId)
      continue
    }
    const base = { startedAt: call.started_at ?? 0, number: line.number, duration: call.duration ?? 0 }
    if (content.summary) summaryBlocks.push({ ...base, text: content.summary })
    if (content.transcript) transcriptBlocks.push({ ...base, text: content.transcript })
  }

  const eligible = calls.filter((c) => needsAi(c.call)).length
  if (withoutAi.length) {
    notes.push(
      withoutAi.length === eligible
        ? "Kein Transkript/Summary von Aircall"
        : `Kein Transkript/Summary von Aircall (Call ${withoutAi.join(", ")})`
    )
  }

  const s = truncate(mergeBlocks(summaryBlocks))
  const t = truncate(mergeBlocks(transcriptBlocks))
  if (s.truncated) notes.push("AI Summary gekürzt (> 95.000 Zeichen)")
  if (t.truncated) notes.push("Transkript gekürzt (> 95.000 Zeichen)")

  const fields: Record<string, unknown> = {
    [F.DURATION]: duration,
    [F.MERGE_STATUS]: "ok",
    [F.MERGE_FEHLER]: notes.join("\n") || null,
  }
  if (s.text) fields[F.AI_SUMMARY] = s.text
  if (t.text) fields[F.TRANSKRIPT] = t.text

  return { kind: "write", status: "ok", notes, duration, summary: s.text, transcript: t.text, fields }
}

/**
 * Nur Bericht: Erwarteter Haupt-Call = laengster beantworteter Call,
 * bzw. der letzte (started_at), wenn keiner beantwortet wurde.
 */
export function expectedMainCall(fetched: FetchedCall[]): string | null {
  const calls = fetched.filter((f): f is { line: CallLine; call: AircallCall } => f.call !== null)
  if (calls.length === 0) return null
  const answered = calls.filter((c) => isAnswered(c.call))
  const pick = answered.length
    ? answered.reduce((a, b) => ((b.call.duration ?? 0) > (a.call.duration ?? 0) ? b : a))
    : calls.reduce((a, b) => ((b.call.started_at ?? 0) >= (a.call.started_at ?? 0) ? b : a))
  return pick.line.callId
}
