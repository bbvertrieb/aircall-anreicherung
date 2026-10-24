import { describe, expect, it } from "vitest"
import { F } from "../src/config"
import { runEnrichment } from "../src/run"
import { FakeAircall, FakeAirtable, FakeClock, NOW, budget, call, line, record, su } from "./helpers"

function setup(n: number, opts: { maxSub?: number; runtime?: number; calls?: Record<string, any> } = {}) {
  const clock = new FakeClock(NOW)
  const b = budget(clock, opts.maxSub, opts.runtime)
  const recs = Array.from({ length: n }, (_, i) => record(`rec${i + 1}`, [line(i + 1)]))
  const calls = opts.calls ?? Object.fromEntries(recs.map((_, i) => [String(i + 1), call(i + 1, { duration: 20 })]))
  const airtable = new FakeAirtable(recs, b)
  const aircall = new FakeAircall(calls, { "1": { summary: su("S") } }, b)
  return { clock, b, airtable, aircall, deps: { airtable, aircall, budget: b, clock } }
}

describe("runEnrichment", () => {
  it("dryrun schreibt nichts", async () => {
    const s = setup(3)
    const { stats, reports } = await runEnrichment(s.deps, { mode: "dryrun", limit: 150 })
    expect(s.airtable.updates).toEqual([])
    expect(stats).toMatchObject({ selected: 3, processed: 3, ok: 3, written: 0, abortReason: null })
    expect(reports.every((r) => r.uuidIsMain === "ja")).toBe(true)
  })

  it("write: Batches à max. 10 Records", async () => {
    const s = setup(23)
    const { stats } = await runEnrichment(s.deps, { mode: "write", limit: 150 })
    expect(s.airtable.updates.map((u) => u.length)).toEqual([10, 10, 3])
    expect(stats.written).toBe(23)
    expect(s.airtable.updates[0]![0]!.fields[F.MERGE_STATUS]).toBe("ok")
  })

  it("übersprungene Records (transient) werden nicht geschrieben", async () => {
    const s = setup(2, { calls: { "1": call(1, { duration: 20 }), "2": "transient" } })
    const { stats } = await runEnrichment(s.deps, { mode: "write", limit: 150 })
    expect(s.airtable.updates.flat().map((u) => u.id)).toEqual(["rec1"])
    expect(stats).toMatchObject({ skipped: 1, transientSkips: 1, written: 1 })
  })

  it("Aircall 401 -> Abbruch, bereits fertige Records werden noch geschrieben", async () => {
    const s = setup(3, { calls: { "1": call(1, { duration: 20 }), "2": "auth", "3": call(3) } })
    const { stats } = await runEnrichment(s.deps, { mode: "write", limit: 150 })
    expect(stats.abortReason).toMatch(/aircall: Zugang verweigert/)
    expect(s.airtable.updates.flat().map((u) => u.id)).toEqual(["rec1"])
    expect(s.aircall.requests).not.toContain("/calls/3")
  })

  it("Subrequest-Budget: hört sauber auf, Rest im nächsten Lauf, schreibt Fertiges", async () => {
    const s = setup(100, { maxSub: 100 })
    const { stats } = await runEnrichment(s.deps, { mode: "write", limit: 150 })
    expect(stats.abortReason).toMatch(/Budget/)
    expect(stats.notReached).toBeGreaterThan(0)
    expect(stats.processed + stats.notReached).toBe(100)
    expect(stats.requestsAirtable + stats.requestsAircall).toBeLessThanOrEqual(100)
    expect(stats.written).toBe(stats.processed)
  })

  it("Laufzeit-Budget: kein neues Protokoll, wenn < 90 s übrig", async () => {
    const s = setup(5, { runtime: 80_000 })
    const { stats } = await runEnrichment(s.deps, { mode: "dryrun", limit: 150 })
    expect(stats).toMatchObject({ processed: 0, notReached: 5 })
  })

  it("--records: nur diese, Backup-Hook vor dem Schreiben, gesetzter Merge-Status wird übersprungen", async () => {
    const s = setup(3)
    s.airtable.records[2]!.fields[F.MERGE_STATUS] = "ok"
    const order: string[] = []
    const orig = s.airtable.updateRecords.bind(s.airtable)
    s.airtable.updateRecords = async (u) => {
      order.push("update")
      return orig(u)
    }
    const { stats, reports } = await runEnrichment(s.deps, {
      mode: "write",
      limit: 10,
      recordIds: ["rec2", "rec3", "recXXX"],
      beforeWrite: async (rs) => {
        order.push(`backup:${rs.map((r) => r.id).join(",")}`)
      },
    })
    expect(order).toEqual(["backup:rec2,rec3", "update"])
    expect(s.airtable.updates.flat().map((u) => u.id)).toEqual(["rec2"])
    expect(stats).toMatchObject({ selected: 2, skipped: 1, written: 1 })
    expect(reports.map((r) => [r.recordId, r.plan.kind])).toEqual([
      ["recXXX", "skip"],
      ["rec2", "write"],
      ["rec3", "skip"],
    ])
  })

  it("übersprungene zählen nicht gegen MAX_RECORDS_PER_RUN: weiterblättern bis Limit erreicht", async () => {
    const calls: Record<string, any> = {}
    for (let i = 1; i <= 25; i++) calls[String(i)] = i <= 12 ? "transient" : call(i, { duration: 20 })
    const s = setup(25, { calls })
    s.airtable.pageSize = 10
    const { stats, reports } = await runEnrichment(s.deps, { mode: "write", limit: 5 })
    expect(stats).toMatchObject({ processed: 5, skipped: 12, transientSkips: 12, written: 5, selected: 20, notReached: 3, abortReason: null })
    expect(s.airtable.pagesLoaded).toBe(2) // Seite 3 wird nicht mehr geladen
    expect(s.airtable.updates.flat().map((u) => u.id)).toEqual(["rec13", "rec14", "rec15", "rec16", "rec17"])
    expect(reports.filter((r) => r.plan.kind === "skip")).toHaveLength(12)
  })

  it("nur übersprungene: alle Seiten bis zum Ende, nichts geschrieben", async () => {
    const calls = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(i + 1), "transient"]))
    const s = setup(7, { calls })
    s.airtable.pageSize = 3
    const { stats } = await runEnrichment(s.deps, { mode: "write", limit: 5 })
    expect(stats).toMatchObject({ processed: 0, skipped: 7, selected: 7, notReached: 0, written: 0, abortReason: null })
    expect(s.airtable.pagesLoaded).toBe(3)
    expect(s.airtable.updates).toEqual([])
  })

  it("Limit genau am Seitenende: keine weitere Seite laden", async () => {
    const s = setup(20)
    s.airtable.pageSize = 10
    const { stats } = await runEnrichment(s.deps, { mode: "dryrun", limit: 10 })
    expect(stats).toMatchObject({ processed: 10, selected: 10, notReached: 0 })
    expect(s.airtable.pagesLoaded).toBe(1)
  })
})
