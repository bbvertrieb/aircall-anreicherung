/**
 * Teil B: Altbestand ohne "Aircall Calls", nur mit gespeicherter "Aircall Call UUID".
 * Reine Funktionen (ohne I/O): Bereiche, Prueffunktionen P1–P5, Schreibplan.
 *
 * Grundregel: Es darf NICHTS falsch zugeordnet werden. Jede Pruefung, die nicht
 * eindeutig besteht, fuehrt zu "prüfen" + Grund – sonst wird nichts geschrieben.
 */
import type { AircallCall } from "./aircall"
import type { ProtokollRecord } from "./airtable"
import { F, LIMITS } from "./config"
import { normDigits, samePhone } from "./phone"
import { AiContent, FetchedCall, Plan, WritePlan, finalize, isAnswered, needsAi, notFoundNote } from "./rules"
import { truncate } from "./text"

export type TeilBRange = "B1" | "B2"

export const B2_NOT_FOUND = "B2: Call 404 – alte n8n-Daten nicht verifizierbar"

/** Zusaetzliche Felder in PROTOKOLLE (per ID). */
export const FB = {
  AP_PHONE: "fldiJLD1aN30CYK0S", // AP Telefonnummer (Snapshot, Text)
  LEAD_PHONE: "fldRSdGAFpatzVuGk", // Telefonnummer (from LEAD BASE), Lookup -> Liste
  OPERATOR: "fldyJdGyDoKs4WslE", // Operator (Link)
} as const

/** CALLER ROUTING: Aircall Number ID -> Operator. */
export const ROUTING = {
  TABLE_ID: "tblnVRfK3Pi4b9vzb",
  NUMBER_ID: "fld1OstRatpMzWOTa",
  OPERATOR: "fldBdzt1wVMFEugmg",
  NAME: "fldZW7zDwE7QiArPg",
  ACTIVE: "fldwojfLZkbsrE9yd", // nur fuer den Bericht
} as const

/**
 * Bereiche nach Erstellzeit, Uhrzeit Wien (beide Grenzen in CEST, UTC+2).
 * `from` inklusiv, `to` exklusiv.
 */
export const RANGES: Record<TeilBRange, { from: string; to: string; label: string }> = {
  B1: { from: "2026-07-22T22:00:00.000Z", to: "2026-10-22T22:00:00.000Z", label: "23.07.–22.10.2026" },
  B2: { from: "2026-05-31T22:00:00.000Z", to: "2026-07-20T22:00:00.000Z", label: "01.06.–20.07.2026" },
}

export function rangeOf(createdTime: string): TeilBRange | null {
  const t = Date.parse(createdTime)
  if (!Number.isFinite(t)) return null
  for (const r of ["B1", "B2"] as const) {
    if (t >= Date.parse(RANGES[r].from) && t < Date.parse(RANGES[r].to)) return r
  }
  return null
}

/** Auswahl-Formel (Feldnamen, filterByFormula kennt keine IDs). Optional engeres Zeitfenster. */
export function selectFormula(range: TeilBRange, from = RANGES[range].from, to = RANGES[range].to): string {
  return (
    "AND({Aircall Calls}='', {Aircall Call UUID}!='', {Merge-Status}='', " +
    `NOT(IS_BEFORE(CREATED_TIME(), '${from}')), IS_BEFORE(CREATED_TIME(), '${to}'))`
  )
}

/** Andere Protokolle, in denen die Call-ID vorkommt (UUID-Feld oder Zeile in "Aircall Calls"). */
export function duplicateFormula(recordId: string, callId: string): string {
  return `AND(RECORD_ID()!='${recordId}', OR({Aircall Call UUID}='${callId}', FIND('${callId}', {Aircall Calls})))`
}

/** Treffer der Duplikat-Suche exakt nachpruefen (FIND ist ein Teilstring-Vergleich). */
export function isExactDuplicate(fields: Record<string, unknown>, callId: string): boolean {
  if (str(fields[F.CALL_UUID]).trim() === callId) return true
  return str(fields[F.AIRCALL_CALLS])
    .split(/\r?\n/)
    .some((l) => l.split("|")[0]?.trim() === callId)
}

export interface RoutingEntry {
  numberId: string
  operators: string[]
  name: string
  active: boolean | null
}

export type CheckId = "P1" | "P2" | "P3" | "P4" | "P5"

export interface Check {
  id: CheckId
  ok: boolean
  detail: string
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v))
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : v == null || v === "" ? [] : [str(v)])

/** Nummern des Protokolls: AP Telefonnummer + alle Werte des Lookups (leere ignoriert). */
export function protocolNumbers(record: ProtokollRecord): { source: string; number: string }[] {
  const out: { source: string; number: string }[] = []
  for (const n of list(record.fields[FB.AP_PHONE])) if (normDigits(n)) out.push({ source: "AP Telefonnummer", number: n })
  for (const n of list(record.fields[FB.LEAD_PHONE])) if (normDigits(n)) out.push({ source: "LEAD BASE", number: n })
  return out
}

export function checkP1(record: ProtokollRecord, call: AircallCall): Check {
  const nums = protocolNumbers(record)
  if (nums.length === 0) return { id: "P1", ok: false, detail: "keine Nummer im Protokoll (AP Telefonnummer und LEAD BASE leer)" }
  if (!normDigits(call.raw_digits)) return { id: "P1", ok: false, detail: "Aircall raw_digits leer" }
  const hit = nums.find((n) => samePhone(n.number, call.raw_digits))
  if (hit) return { id: "P1", ok: true, detail: `passt zu ${hit.source} (${hit.number})` }
  return {
    id: "P1",
    ok: false,
    detail: `Nummer passt nicht (Aircall "${call.raw_digits}", Protokoll ${nums.map((n) => `"${n.number}"`).join(", ")})`,
  }
}

export function checkP2(record: ProtokollRecord, call: AircallCall, routing: Map<string, RoutingEntry[]>): Check {
  const ops = list(record.fields[FB.OPERATOR])
  if (ops.length === 0) return { id: "P2", ok: false, detail: "kein Operator im Protokoll" }
  if (ops.length > 1) return { id: "P2", ok: false, detail: `mehrere Operatoren im Protokoll (${ops.join(", ")})` }
  const numberId = call.number?.id
  if (numberId == null || str(numberId).trim() === "") return { id: "P2", ok: false, detail: "Aircall-Leitung (number.id) fehlt" }
  const lineName = call.number?.name ?? ""
  const entries = routing.get(str(numberId)) ?? []
  if (entries.length === 0) {
    return { id: "P2", ok: false, detail: `Leitung ${numberId} "${lineName}" nicht (mehr) im CALLER ROUTING` }
  }
  const routed = [...new Set(entries.flatMap((e) => e.operators))]
  if (routed.length !== 1) {
    return { id: "P2", ok: false, detail: `Leitung ${numberId} "${lineName}" im CALLER ROUTING nicht eindeutig (Operatoren: ${routed.join(", ") || "keiner"})` }
  }
  if (routed[0] !== ops[0]) {
    return { id: "P2", ok: false, detail: `Leitung ${numberId} "${lineName}" gehört zu Operator ${routed[0]}, Protokoll hat ${ops[0]}` }
  }
  return { id: "P2", ok: true, detail: `Leitung ${numberId} "${lineName}" → ${ops[0]}` }
}

/** P3: Call-Start 0–60 Min VOR der Erstellzeit des Protokolls. */
export function checkP3(record: ProtokollRecord, call: AircallCall): Check {
  const created = Date.parse(record.createdTime) / 1000
  if (!Number.isFinite(created)) return { id: "P3", ok: false, detail: "Erstellzeit fehlt" }
  if (call.started_at == null) return { id: "P3", ok: false, detail: "Aircall started_at fehlt" }
  const delta = created - call.started_at
  const min = (delta / 60).toFixed(1)
  if (delta >= 0 && delta <= 3600) return { id: "P3", ok: true, detail: `Call ${min} Min vor Protokoll` }
  return {
    id: "P3",
    ok: false,
    detail: delta < 0 ? `Call startet ${(-delta / 60).toFixed(1)} Min NACH dem Protokoll` : `Call ${min} Min vor Protokoll (> 60)`,
  }
}

export function checkP4(duplicates: string[]): Check {
  return duplicates.length
    ? { id: "P4", ok: false, detail: `Call-ID auch in ${duplicates.join(", ")}` }
    : { id: "P4", ok: true, detail: "eindeutig" }
}

export function checkP5(call: AircallCall): Check {
  return call.direction === "outbound"
    ? { id: "P5", ok: true, detail: "outbound" }
    : { id: "P5", ok: false, detail: `direction "${call.direction ?? ""}" statt outbound` }
}

export function runChecks(record: ProtokollRecord, call: AircallCall, routing: Map<string, RoutingEntry[]>, duplicates: string[]): Check[] {
  return [checkP1(record, call), checkP2(record, call, routing), checkP3(record, call), checkP4(duplicates), checkP5(call)]
}

function statusOnly(status: "prüfen" | "fehler", notes: string[]): WritePlan {
  return { kind: "write", status, notes, fields: { [F.MERGE_STATUS]: status, [F.MERGE_FEHLER]: notes.join("\n") } }
}

/** Vorab (ohne Aircall): gueltige UUID? */
export function precheckB(record: ProtokollRecord, range: TeilBRange): WritePlan | null {
  const uuid = str(record.fields[F.CALL_UUID]).trim()
  if (!/^\d+$/.test(uuid)) return statusOnly("prüfen", [`${range}: Aircall Call UUID ungültig ("${uuid}")`])
  return null
}

/**
 * Plan nach den Pruefungen. `call === null` = 404. AI-Inhalte nur, wenn alle
 * Pruefungen bestanden und der Call beantwortet und >= 30 s ist.
 */
export function planB(
  range: TeilBRange,
  record: ProtokollRecord,
  call: AircallCall | null,
  checks: Check[],
  ai: AiContent | null,
  nowMs: number
): Plan {
  const uuid = str(record.fields[F.CALL_UUID]).trim()
  if (!call) {
    // B2: alte n8n-Daten lassen sich ohne Call nicht verifizieren -> pruefen. B1 (noch keine Daten): wie Teil A.
    return range === "B2" ? statusOnly("prüfen", [B2_NOT_FOUND]) : statusOnly("fehler", [notFoundNote(uuid)])
  }
  const failed = checks.filter((c) => !c.ok)
  if (failed.length) return statusOnly("prüfen", failed.map((c) => `${range}: ${c.id} ${c.detail}`))

  if (range === "B1") {
    const filled = [F.DURATION, F.AI_SUMMARY, F.TRANSKRIPT].filter((f) => str(record.fields[f]).trim() !== "")
    if (filled.length) return statusOnly("prüfen", ["B1: Felder bereits befüllt – nicht überschrieben"])
    const fetched: FetchedCall[] = [{ line: { callId: uuid, number: str(call.raw_digits), iso: "", raw: uuid }, call }]
    const m = new Map<string, AiContent>()
    if (ai) m.set(uuid, ai)
    return finalize(fetched, m, nowMs)
  }

  // B2: nur Transkript, nur wenn das Feld leer ist; Duration/AI Summary nie anfassen.
  // "prüfen" bedeutet hier ausschliesslich zweifelhafte Zuordnung (oben).
  if (str(record.fields[F.TRANSKRIPT]).trim() !== "") {
    const notes = ["B2: Transkript bereits vorhanden – nichts geschrieben"]
    return { kind: "write", status: "ok", notes, fields: { [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: notes.join("\n") } }
  }
  if (!isAnswered(call)) {
    // wie Teil A: kein Gespraech, Merge-Fehler leer; Duration bleibt unangetastet (B2)
    return { kind: "write", status: "kein Gespräch", notes: [], fields: { [F.MERGE_STATUS]: "kein Gespräch", [F.MERGE_FEHLER]: null } }
  }
  const t = truncate(ai?.transcript ?? "")
  if (t.text) {
    const notes = ["B2: nur Transkript", ...(t.truncated ? ["Transkript gekürzt (> 95.000 Zeichen)"] : [])]
    return {
      kind: "write",
      status: "ok",
      notes,
      transcript: t.text,
      fields: { [F.TRANSKRIPT]: t.text, [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: notes.join("\n") },
    }
  }
  const why = !needsAi(call) ? `Call kürzer als ${LIMITS.AI_MIN_DURATION_S} s` : "kein Transkript bei Aircall"
  const notes = [`B2: nur Transkript – ${why}, nichts geschrieben`]
  return { kind: "write", status: "ok", notes, fields: { [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: notes.join("\n") } }
}
