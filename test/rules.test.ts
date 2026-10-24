import { describe, expect, it } from "vitest"
import { F, TRUNCATE_SUFFIX } from "../src/config"
import { processRecord } from "../src/run"
import { expectedMainCall } from "../src/rules"
import { FakeAircall, H, NOW, call, line, record, su, tr } from "./helpers"

const run = (rec: ReturnType<typeof record>, ac: FakeAircall, now = NOW) => processRecord(rec, ac, now)

describe("Status-Regeln", () => {
  it("ein Call mit Transkript + Summary -> ok, Texte ohne Kopfzeile", async () => {
    const ac = new FakeAircall({ "1": call(1) }, { "1": { transcript: tr("Hallo", "Ja bitte"), summary: su("Termin vereinbart") } })
    const { plan } = await run(record("rec1", [line(1)]), ac)
    expect(plan).toMatchObject({ kind: "write", status: "ok", duration: 120 })
    if (plan.kind !== "write") throw 0
    expect(plan.fields).toEqual({
      [F.DURATION]: 120,
      [F.MERGE_STATUS]: "ok",
      [F.MERGE_FEHLER]: null,
      [F.AI_SUMMARY]: "Termin vereinbart",
      [F.TRANSKRIPT]: "[internal] Hallo\n[external] Ja bitte",
    })
  })

  it("mehrere Calls: Dauer = Summe inkl. Klingelzeit, Kopfzeilen nur bei >= 2 Calls mit Inhalt", async () => {
    const t0 = NOW / 1000 - 20 * H
    const ac = new FakeAircall(
      {
        "1": call(1, { duration: 15, answered_at: null }), // nicht beantwortet, Klingelzeit
        "2": call(2, { duration: 200, started_at: t0 + 600, raw_digits: "+43 664 1234567" }),
        "3": call(3, { duration: 95, started_at: t0 + 60 }),
      },
      {
        "2": { transcript: tr("Zweiter"), summary: su("S2") },
        "3": { transcript: tr("Dritter"), summary: null },
      }
    )
    const { plan } = await run(record("rec1", [line(1), line(2, "06641234567"), line(3)]), ac)
    if (plan.kind !== "write") throw new Error("write erwartet")
    expect(plan.status).toBe("ok")
    expect(plan.duration).toBe(310)
    expect(plan.summary).toBe("S2") // nur ein Call mit Summary -> ohne Kopfzeile
    expect(plan.transcript).toBe(
      "── 02:01 · +4915121719265 · 1:35 Min ──\n[internal] Dritter\n\n── 02:10 · 06641234567 · 3:20 Min ──\n[internal] Zweiter"
    )
    expect(ac.requests).not.toContain("/calls/1/transcription") // nicht beantwortet -> keine AI-Abfrage
  })

  it("AI nur bei beantwortet UND >= 30 s", async () => {
    const ac = new FakeAircall({ "1": call(1, { duration: 29 }) })
    const { plan } = await run(record("rec1", [line(1)]), ac)
    expect(ac.requests).toEqual(["/calls/1"])
    expect(plan).toMatchObject({ kind: "write", status: "ok", notes: [] })
  })

  it("kein Call beantwortet -> Dauer + kein Gespräch", async () => {
    const ac = new FakeAircall({ "1": call(1, { answered_at: null, duration: 25 }), "2": call(2, { answered_at: null, duration: 31 }) })
    const { plan } = await run(record("rec1", [line(1), line(2)]), ac)
    if (plan.kind !== "write") throw 0
    expect(plan.fields).toEqual({ [F.DURATION]: 56, [F.MERGE_STATUS]: "kein Gespräch", [F.MERGE_FEHLER]: null })
  })

  it("Nummer passt nicht -> nur prüfen + Merge-Fehler", async () => {
    const ac = new FakeAircall({ "1": call(1, { raw_digits: "+49 30 1234567" }) })
    const { plan } = await run(record("rec1", [line(1)]), ac)
    if (plan.kind !== "write") throw 0
    expect(Object.keys(plan.fields).sort()).toEqual([F.MERGE_FEHLER, F.MERGE_STATUS].sort())
    expect(plan.status).toBe("prüfen")
    expect(plan.fields[F.MERGE_FEHLER]).toContain("Call 1: Nummer passt nicht")
    expect(plan.fields[F.MERGE_FEHLER]).toContain("+49 30 1234567")
    expect(ac.requests).toEqual(["/calls/1"]) // keine AI-Abfragen
  })

  it("direction inbound -> prüfen", async () => {
    const { plan } = await run(record("rec1", [line(1)]), new FakeAircall({ "1": call(1, { direction: "inbound" }) }))
    expect(plan).toMatchObject({ status: "prüfen", notes: ['Call 1: direction "inbound" statt outbound'] })
  })

  it("Felder bereits befüllt -> nicht überschreiben, prüfen", async () => {
    const ac = new FakeAircall({ "1": call(1) }, { "1": { transcript: tr("x") } })
    const { plan } = await run(record("rec1", [line(1)], { [F.TRANSKRIPT]: "alt" }), ac)
    if (plan.kind !== "write") throw 0
    expect(plan.fields).toEqual({ [F.MERGE_STATUS]: "prüfen", [F.MERGE_FEHLER]: "Felder bereits befüllt – nicht überschrieben" })
  })

  it("Call 404 -> fehler", async () => {
    const { plan } = await run(record("rec1", [line(1), line(2)]), new FakeAircall({ "1": call(1), "2": null }))
    expect(plan).toMatchObject({ status: "fehler", notes: ["Call 2 bei Aircall nicht gefunden (404)"] })
  })

  it("unlesbare Zeile -> prüfen, ohne Aircall-Request", async () => {
    const ac = new FakeAircall({})
    const { plan } = await run(record("rec1", ["kaputt | +49"]), ac)
    expect(plan).toMatchObject({ status: "prüfen" })
    expect(ac.requests).toEqual([])
  })

  it("Transient (5xx/429 nach Retries) -> Record unverändert", async () => {
    const { plan } = await run(record("rec1", [line(1)]), new FakeAircall({ "1": "transient" }))
    expect(plan).toMatchObject({ kind: "skip" })
  })

  it("401/403 -> Fehler wird durchgereicht (Lauf-Abbruch)", async () => {
    await expect(run(record("rec1", [line(1)]), new FakeAircall({ "1": "auth" }))).rejects.toThrow(/Zugang/)
  })

  it("beantwortet >= 30 s ohne AI: jünger 12 h -> unverändert, älter -> ok mit Hinweis", async () => {
    const young = call(1, { started_at: NOW / 1000 - 2 * H, ended_at: NOW / 1000 - 2 * H + 120 })
    expect((await run(record("r", [line(1)]), new FakeAircall({ "1": young }))).plan).toMatchObject({ kind: "skip" })

    const { plan } = await run(record("r", [line(1)]), new FakeAircall({ "1": call(1) }))
    if (plan.kind !== "write") throw 0
    expect(plan.fields).toEqual({ [F.DURATION]: 120, [F.MERGE_STATUS]: "ok", [F.MERGE_FEHLER]: "Kein Transkript/Summary von Aircall" })
  })

  it("teilweise ohne AI (alt) -> Hinweis mit Call-ID", async () => {
    const ac = new FakeAircall({ "1": call(1), "2": call(2) }, { "1": { summary: su("S") } })
    const { plan } = await run(record("r", [line(1), line(2)]), ac)
    expect(plan).toMatchObject({ status: "ok", notes: ["Kein Transkript/Summary von Aircall (Call 2)"], summary: "S" })
  })

  it("> 95.000 Zeichen -> gekürzt + Hinweis in Merge-Fehler", async () => {
    const ac = new FakeAircall({ "1": call(1) }, { "1": { transcript: { transcription: { content: "z".repeat(100_000) } } } })
    const { plan } = await run(record("r", [line(1)]), ac)
    if (plan.kind !== "write") throw 0
    expect(plan.transcript).toBe("z".repeat(95_000) + TRUNCATE_SUFFIX)
    expect(plan.fields[F.MERGE_FEHLER]).toBe("Transkript gekürzt (> 95.000 Zeichen)")
    expect(plan.status).toBe("ok")
  })

  it("Haupt-Call-Bericht: längster beantworteter, sonst letzter", () => {
    const l = (id: number) => ({ callId: String(id), number: "", iso: "", raw: "" })
    expect(
      expectedMainCall([
        { line: l(1), call: call(1, { duration: 300 }) },
        { line: l(2), call: call(2, { duration: 500, answered_at: null }) },
        { line: l(3), call: call(3, { duration: 100 }) },
      ])
    ).toBe("1")
    expect(
      expectedMainCall([
        { line: l(1), call: call(1, { answered_at: null, started_at: 200 }) },
        { line: l(2), call: call(2, { answered_at: null, started_at: 100 }) },
      ])
    ).toBe("1")
  })
})
