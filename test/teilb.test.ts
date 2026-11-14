import { describe, expect, it } from "vitest"
import type { AircallCall } from "../src/aircall"
import type { AirtableQueryApi, ProtokollRecord, QueryParams } from "../src/airtable"
import { AIRTABLE, F, readSettings } from "../src/config"
import { FB, ROUTING, RoutingEntry, checkP1, checkP2, checkP3, isExactDuplicate, planB, rangeOf, runChecks } from "../src/teilbRules"
import { runTeilB } from "../src/teilbRun"
import { teilbBlocked } from "../src/worker"
import { FakeAircall, FakeAirtable, FakeClock, budget, su, tr } from "./helpers"

const OP = "recOPERATOR1"
const CREATED = "2026-09-10T08:30:00.000Z" // B1
const created = Date.parse(CREATED) / 1000

function rec(id: string, o: { uuid?: string; created?: string; fields?: Record<string, unknown> } = {}): ProtokollRecord {
  return {
    id,
    createdTime: o.created ?? CREATED,
    fields: {
      [F.CALL_UUID]: o.uuid ?? "5001",
      [F.FIRMA]: [`Firma ${id}`],
      [FB.AP_PHONE]: "+49 711 123456",
      [FB.LEAD_PHONE]: ["+49 89 999999", "+49 711 123456"],
      [FB.OPERATOR]: [OP],
      ...o.fields,
    },
  }
}

function bcall(id: number, o: Partial<AircallCall> = {}): AircallCall {
  return {
    id,
    direction: "outbound",
    raw_digits: "+49 711 123456",
    duration: 95,
    started_at: created - 5 * 60,
    answered_at: created - 5 * 60 + 8,
    ended_at: created - 5 * 60 + 95,
    number: { id: 777, name: "Kunde X - Anna", digits: "+49 15888 000000" },
    user: { id: 1, name: "Anna" },
    ...o,
  }
}

const routing = (entries: [string, string[]][] = [["777", [OP]]]) =>
  new Map<string, RoutingEntry[]>(entries.map(([n, ops]) => [n, [{ numberId: n, operators: ops, name: `Leitung ${n}`, active: true }]]))

/** Airtable-Fake mit query(): CALLER ROUTING, Auswahl und Duplikat-Suche. */
class FakeAirtableB extends FakeAirtable implements AirtableQueryApi {
  queries: QueryParams[] = []
  constructor(records: ProtokollRecord[], public others: ProtokollRecord[] = [], public routingRows = [["777", [OP]]] as [string, string[]][]) {
    super(records)
  }
  async query(table: string, q: QueryParams) {
    this.queries.push(q)
    if (table === ROUTING.TABLE_ID) {
      return {
        records: this.routingRows.map(([n, ops], i) => ({
          id: `recR${i}`,
          createdTime: "",
          fields: { [ROUTING.NUMBER_ID]: n, [ROUTING.OPERATOR]: ops, [ROUTING.NAME]: `Leitung ${n}` },
        })),
      }
    }
    expect(table).toBe(AIRTABLE.TABLE_ID)
    const dup = /RECORD_ID\(\)!='(\w+)'.*FIND\('(\d+)'/.exec(q.formula ?? "")
    if (dup) {
      const [, self, id] = dup
      const all = [...this.records, ...this.others].filter((r) => r.id !== self)
      // wie FIND: Teilstring in UUID oder "Aircall Calls"
      return { records: all.filter((r) => String(r.fields[F.CALL_UUID] ?? "") === id || String(r.fields[F.AIRCALL_CALLS] ?? "").includes(id!)) }
    }
    return { records: this.records }
  }
}

const NOWB = Date.UTC(2026, 10, 14, 20, 0)

describe("Teil B – Bereiche", () => {
  it("B1 23.07.–22.10., B2 01.06.–20.07. (Wien), sonst keiner", () => {
    expect(rangeOf("2026-07-22T21:59:59.000Z")).toBeNull() // 22.07. 23:59:59 Wien
    expect(rangeOf("2026-07-22T22:00:00.000Z")).toBe("B1") // 23.07. 00:00 Wien
    expect(rangeOf("2026-10-22T21:59:59.000Z")).toBe("B1") // 22.10. 23:59:59 Wien
    expect(rangeOf("2026-10-22T22:00:00.000Z")).toBeNull()
    expect(rangeOf("2026-05-31T22:00:00.000Z")).toBe("B2")
    expect(rangeOf("2026-07-20T21:59:59.000Z")).toBe("B2")
    expect(rangeOf("2026-07-21T10:00:00.000Z")).toBeNull() // Lücke 21./22.07.
  })
  it("Schalter: Standard aus", () => {
    expect(readSettings({})).toMatchObject({ teilbRanges: [], teilbMax: 0 })
    expect(readSettings({ TEILB_RANGES: "b1, B2,x", MAX_TEILB_PER_RUN: "40" })).toMatchObject({ teilbRanges: ["B1", "B2"], teilbMax: 40 })
    expect(readSettings({ MAX_TEILB_PER_RUN: "-3" }).teilbMax).toBe(0)
  })
})

describe("Teil B – Prüfungen", () => {
  it("P1: eine Lookup-Nummer oder AP Telefonnummer genügt; leer -> prüfen", () => {
    expect(checkP1(rec("r", { fields: { [FB.AP_PHONE]: "", [FB.LEAD_PHONE]: ["+43 1 555", "0711 123456"] } }), bcall(1)).ok).toBe(true)
    expect(checkP1(rec("r", { fields: { [FB.LEAD_PHONE]: [] } }), bcall(1)).ok).toBe(true)
    const none = checkP1(rec("r", { fields: { [FB.AP_PHONE]: "", [FB.LEAD_PHONE]: [""] } }), bcall(1))
    expect(none).toMatchObject({ ok: false, detail: expect.stringContaining("keine Nummer") })
    expect(checkP1(rec("r"), bcall(1, { raw_digits: "+49 30 111111" })).ok).toBe(false)
    expect(checkP1(rec("r"), bcall(1, { raw_digits: "" })).ok).toBe(false)
  })
  it("P2: Leitung im Routing beim Operator des Protokolls; sonst prüfen", () => {
    expect(checkP2(rec("r"), bcall(1), routing()).ok).toBe(true)
    expect(checkP2(rec("r"), bcall(1), routing([["778", [OP]]])).detail).toContain("nicht (mehr) im CALLER ROUTING")
    expect(checkP2(rec("r"), bcall(1), routing([["777", ["recANDERER"]]])).detail).toContain("gehört zu Operator recANDERER")
    const amb = new Map([["777", [{ numberId: "777", operators: [OP], name: "a", active: true }, { numberId: "777", operators: ["recX"], name: "b", active: false }]]])
    expect(checkP2(rec("r"), bcall(1), amb).detail).toContain("nicht eindeutig")
    expect(checkP2(rec("r", { fields: { [FB.OPERATOR]: [] } }), bcall(1), routing()).detail).toContain("kein Operator")
    expect(checkP2(rec("r", { fields: { [FB.OPERATOR]: [OP, "recB"] } }), bcall(1), routing()).detail).toContain("mehrere Operatoren")
    expect(checkP2(rec("r"), bcall(1, { number: null }), routing()).ok).toBe(false)
  })
  it("P3: Call 0–60 Min vor der Erstellzeit", () => {
    expect(checkP3(rec("r"), bcall(1, { started_at: created })).ok).toBe(true)
    expect(checkP3(rec("r"), bcall(1, { started_at: created - 3600 })).ok).toBe(true)
    expect(checkP3(rec("r"), bcall(1, { started_at: created - 3601 })).ok).toBe(false)
    expect(checkP3(rec("r"), bcall(1, { started_at: created + 1 })).detail).toContain("NACH")
    expect(checkP3(rec("r"), bcall(1, { started_at: null })).ok).toBe(false)
  })
  it("P4: exakter Vergleich, kein Teilstring-Treffer", () => {
    expect(isExactDuplicate({ [F.CALL_UUID]: "5001" }, "5001")).toBe(true)
    expect(isExactDuplicate({ [F.AIRCALL_CALLS]: "9 | +49 | x\n5001 | +49 | y" }, "5001")).toBe(true)
    expect(isExactDuplicate({ [F.CALL_UUID]: "50012" }, "5001")).toBe(false)
    expect(isExactDuplicate({ [F.AIRCALL_CALLS]: "150010 | +49 | x" }, "5001")).toBe(false)
  })
  it("P5 inbound und mehrere Fehler -> prüfen mit allen Gründen, nichts außer Status/Merge-Fehler", () => {
    const c = bcall(1, { direction: "inbound", raw_digits: "+49 30 1" })
    const checks = runChecks(rec("r"), c, routing(), ["recDUP"])
    const plan = planB("B1", rec("r"), c, checks, null, NOWB)
    expect(plan).toMatchObject({ kind: "write", status: "prüfen" })
    if (plan.kind !== "write") throw 0
    expect(Object.keys(plan.fields).sort()).toEqual([F.MERGE_FEHLER, F.MERGE_STATUS].sort())
    expect(plan.notes.map((n) => n.slice(0, 6))).toEqual(["B1: P1", "B1: P4", "B1: P5"])
    expect(plan.notes[1]).toContain("recDUP")
  })
})

describe("Teil B – Schreibplan", () => {
  const ok = (r: ProtokollRecord, c: AircallCall) => runChecks(r, c, routing(), [])

  it("404: B1 -> fehler (Text wie Teil A), B2 -> prüfen (alte n8n-Daten nicht verifizierbar)", () => {
    const plan = planB("B1", rec("r"), null, [], null, NOWB)
    expect(plan).toMatchObject({ status: "fehler", notes: ["Call 5001 bei Aircall nicht (mehr) vorhanden (404) – Leitung oder Nutzer vermutlich gelöscht"] })
    const b2 = planB("B2", rec("r", { created: "2026-07-15T08:30:00.000Z", fields: { [F.DURATION]: 80 } }), null, [], null, NOWB)
    if (b2.kind !== "write") throw 0
    expect(b2.fields).toEqual({ [F.MERGE_STATUS]: "prüfen", [F.MERGE_FEHLER]: "B2: Call 404 – alte n8n-Daten nicht verifizierbar" })
  })
  it("B1: wie Teil A für einen Call – Dauer, Summary, Transkript ohne Kopfzeile", () => {
    const r = rec("r")
    const c = bcall(1)
    const plan = planB("B1", r, c, ok(r, c), { transcript: "[internal] Hallo", summary: "Termin" }, NOWB)
    if (plan.kind !== "write") throw 0
    expect(plan.fields).toEqual({
      [F.DURATION]: 95,
      [F.MERGE_STATUS]: "ok",
      [F.MERGE_FEHLER]: null,
      [F.AI_SUMMARY]: "Termin",
      [F.TRANSKRIPT]: "[internal] Hallo",
    })
  })
  it("B1: nicht angenommen -> kein Gespräch; bereits befüllt -> prüfen, nichts überschreiben", () => {
    const r = rec("r")
    const c = bcall(1, { answered_at: null, duration: 30 })
    expect(planB("B1", r, c, ok(r, c), null, NOWB)).toMatchObject({ status: "kein Gespräch", duration: 30 })
    const filled = rec("f", { fields: { [F.DURATION]: 12 } })
    const p = planB("B1", filled, bcall(1), ok(filled, bcall(1)), { transcript: "x", summary: "y" }, NOWB)
    expect(p).toMatchObject({ status: "prüfen", notes: ["B1: Felder bereits befüllt – nicht überschrieben"] })
    if (p.kind !== "write") throw 0
    expect(p.fields).not.toHaveProperty(F.DURATION)
  })
  it("B2: NUR Transkript; Dauer und AI Summary nie angefasst", () => {
    const r = rec("r", { created: "2026-07-15T08:30:00.000Z", fields: { [F.DURATION]: 80, [F.AI_SUMMARY]: "alt (n8n)" } })
    const c = bcall(1, { started_at: Date.parse("2026-07-15T08:20:00.000Z") / 1000 })
    const plan = planB("B2", r, c, ok(r, c), { transcript: "[internal] Hallo", summary: "neu" }, NOWB)
    if (plan.kind !== "write") throw 0
    expect(plan.fields).toEqual({ [F.TRANSKRIPT]: "[internal] Hallo", [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: "B2: nur Transkript" })
  })
  it("B2: Transkript schon vorhanden + Prüfungen ok -> ok, nichts geschrieben; Prüfung fehlgeschlagen -> prüfen ohne Datenfelder", () => {
    const r = rec("r", { created: "2026-07-15T08:30:00.000Z", fields: { [F.TRANSKRIPT]: "alt" } })
    const c = bcall(1, { started_at: Date.parse("2026-07-15T08:20:00.000Z") / 1000 })
    const p0 = planB("B2", r, c, ok(r, c), { transcript: "neu", summary: "" }, NOWB)
    if (p0.kind !== "write") throw 0
    expect(p0.fields).toEqual({ [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: "B2: Transkript bereits vorhanden – nichts geschrieben" })
    const bad = runChecks(r, bcall(1, { raw_digits: "+41 1 2" }), routing(), [])
    const p = planB("B2", r, c, bad, null, NOWB)
    if (p.kind !== "write") throw 0
    expect(p.status).toBe("prüfen")
    expect(Object.keys(p.fields).sort()).toEqual([F.MERGE_FEHLER, F.MERGE_STATUS].sort())
  })
  it("B2 ohne Transkript: nicht angenommen -> kein Gespräch (Dauer unangetastet); < 30 s / kein Transkript -> ok mit Grund", () => {
    const r = rec("r", { created: "2026-07-15T08:30:00.000Z", fields: { [F.DURATION]: 40 } })
    const t0 = Date.parse("2026-07-15T08:20:00.000Z") / 1000
    const no = bcall(1, { started_at: t0, answered_at: null })
    const p1 = planB("B2", r, no, ok(r, no), null, NOWB)
    if (p1.kind !== "write") throw 0
    expect(p1.fields).toEqual({ [F.MERGE_STATUS]: "kein Gespräch", [F.MERGE_FEHLER]: null })
    const short = bcall(1, { started_at: t0, duration: 20 })
    const p2 = planB("B2", r, short, ok(r, short), null, NOWB)
    if (p2.kind !== "write") throw 0
    expect(p2.fields).toEqual({ [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: "B2: nur Transkript – Call kürzer als 30 s, nichts geschrieben" })
    const none = bcall(1, { started_at: t0 })
    const p3 = planB("B2", r, none, ok(r, none), { transcript: "", summary: "" }, NOWB)
    if (p3.kind !== "write") throw 0
    expect(p3.fields).toEqual({ [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: "B2: nur Transkript – kein Transkript bei Aircall, nichts geschrieben" })
  })
})

describe("runTeilB", () => {
  function setup(records: ProtokollRecord[], calls: Record<string, AircallCall | null>, others: ProtokollRecord[] = []) {
    const clock = new FakeClock(NOWB)
    const b = budget(clock)
    const airtable = new FakeAirtableB(records, others)
    const aircall = new FakeAircall(calls, { "5001": { transcript: tr("Hallo"), summary: su("S") } }, b)
    return { airtable, aircall, deps: { airtable, aircall, budget: b, clock } }
  }

  it("Teil-A-Protokolle (Aircall Calls gefüllt) werden nie angefasst; dryrun schreibt nichts", async () => {
    const a = rec("recA", { fields: { [F.AIRCALL_CALLS]: "5001 | +49 | x" } })
    const s = setup([a, rec("recB")], { "5001": bcall(5001) })
    const { stats, reports } = await runTeilB(s.deps, { mode: "dryrun", limit: 10, ranges: ["B1"] })
    expect(s.airtable.updates).toEqual([])
    expect(reports[0]!.plan).toMatchObject({ kind: "skip", reason: expect.stringContaining("Teil A") })
    // recB: die Call-ID steht auch in recA ("Aircall Calls") -> P4
    expect(reports[1]!.plan).toMatchObject({ status: "prüfen" })
    expect(stats).toMatchObject({ skipped: 1, processed: 1, pruefen: 1, written: 0 })
    expect(stats.pruefenGrund.P4).toBe(1)
  })

  it("write: alle Prüfungen ok -> B1 geschrieben; Bereich nicht aktiv -> übersprungen", async () => {
    const b2 = rec("recJuli", { uuid: "6001", created: "2026-07-15T08:30:00.000Z" })
    const s = setup([rec("recB"), b2], { "5001": bcall(5001), "6001": bcall(6001) })
    const { stats } = await runTeilB(s.deps, { mode: "write", limit: 10, ranges: ["B1"] })
    expect(s.airtable.updates.flat().map((u) => u.id)).toEqual(["recB"])
    expect(s.airtable.updates[0]![0]!.fields[F.TRANSKRIPT]).toBe("[internal] Hallo")
    expect(stats).toMatchObject({ ok: 1, written: 1, skipped: 1 })
  })

  it("AI wird nur abgefragt, wenn alle Prüfungen bestehen; B2 fragt keine Summary ab", async () => {
    const bad = setup([rec("recB")], { "5001": bcall(5001, { direction: "inbound" }) })
    await runTeilB(bad.deps, { mode: "dryrun", limit: 10, ranges: ["B1"] })
    expect(bad.aircall.requests).toEqual(["/calls/5001"])

    const juli = rec("recJ", { created: "2026-07-15T08:30:00.000Z" })
    const s = setup([juli], { "5001": bcall(5001, { started_at: Date.parse("2026-07-15T08:20:00.000Z") / 1000 }) })
    const { reports } = await runTeilB(s.deps, { mode: "dryrun", limit: 10, ranges: ["B2"] })
    expect(s.aircall.requests).toEqual(["/calls/5001", "/calls/5001/transcription"])
    expect(reports[0]!.plan).toMatchObject({ status: "ok", notes: ["B2: nur Transkript"] })
  })

  it("Limit zählt nur verarbeitete Protokolle", async () => {
    const recs = [1, 2, 3].map((i) => rec(`r${i}`, { uuid: String(7000 + i) }))
    const s = setup(recs, Object.fromEntries(recs.map((_, i) => [String(7001 + i), null])))
    const { stats } = await runTeilB(s.deps, { mode: "dryrun", limit: 2, ranges: ["B1"] })
    expect(stats).toMatchObject({ processed: 2, fehler: 2, notReached: 1 })
  })

  it("Statistik: B2-404 zählt als prüfen mit Grund 404", async () => {
    const juli = rec("recJ", { created: "2026-07-15T08:30:00.000Z" })
    const s = setup([juli], { "5001": null })
    const { stats } = await runTeilB(s.deps, { mode: "dryrun", limit: 10, ranges: ["B2"] })
    expect(stats).toMatchObject({ pruefen: 1, fehler: 0 })
    expect(stats.pruefenGrund["404"]).toBe(1)
  })
})

describe("Worker: Teil A hat Vorrang", () => {
  const a = (o: Partial<{ abortReason: string | null; processed: number }>) => ({ abortReason: null, processed: 10, ...o }) as any
  it("Teil B nur, wenn Teil A sauber und unter seinem Limit", () => {
    expect(teilbBlocked(a({}), 180)).toBeNull()
    expect(teilbBlocked(a({ processed: 180 }), 180)).toContain("keine Kapazität")
    expect(teilbBlocked(a({ abortReason: "Budget" }), 180)).toContain("Teil A beendet")
  })
})
