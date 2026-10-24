import { describe, expect, it } from "vitest"
import { AircallClient } from "../src/aircall"
import { AirtableClient } from "../src/airtable"
import { F } from "../src/config"
import { AirtableAbort, AuthError, TransientError } from "../src/http"
import { FakeClock, NOW, budget } from "./helpers"

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

function seq(responses: Response[]) {
  const calls: { url: string; init?: RequestInit; at: number }[] = []
  return { calls, make: (clock: FakeClock) => async (url: string, init?: RequestInit) => {
    calls.push({ url, init, at: clock.now() })
    return responses.shift() ?? json(500)
  } }
}

describe("AircallClient", () => {
  it("429 mit Retry-After, Drossel 1,2 s, Basic Auth", async () => {
    const clock = new FakeClock(NOW)
    const s = seq([json(429, {}, { "Retry-After": "7" }), json(200, { call: { id: 1 } })])
    const c = new AircallClient("id", "tok", budget(clock), clock, s.make(clock))
    expect(await c.getCall("1")).toEqual({ id: 1 })
    expect(s.calls[1]!.at - s.calls[0]!.at).toBe(7_000)
    expect((s.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Basic " + btoa("id:tok"))
  })

  it("404 = nicht vorhanden, 401 = AuthError, 429 ohne Header = 60 s, nach 3 Retries Transient", async () => {
    const clock = new FakeClock(NOW)
    const s = seq([json(404), json(401)])
    const c = new AircallClient("id", "tok", budget(clock), clock, s.make(clock))
    expect(await c.getTranscription("1")).toBeNull()
    await expect(c.getCall("1")).rejects.toBeInstanceOf(AuthError)

    const clock2 = new FakeClock(NOW)
    const s2 = seq([json(429), json(429), json(429), json(429)])
    const c2 = new AircallClient("id", "tok", budget(clock2), clock2, s2.make(clock2))
    await expect(c2.getCall("1")).rejects.toBeInstanceOf(TransientError)
    expect(s2.calls).toHaveLength(4)
    expect(s2.calls[1]!.at - s2.calls[0]!.at).toBe(60_000)
  })
})

describe("AirtableClient", () => {
  it("PATCH ohne typecast, Felder per ID; Liste mit Formel, Sortierung, returnFieldsByFieldId", async () => {
    const clock = new FakeClock(NOW)
    const s = seq([json(200, { records: [{ id: "rec1", createdTime: "", fields: {} }] }), json(200, { records: [] })])
    const c = new AirtableClient("pat", budget(clock), clock, s.make(clock))
    await c.listCandidates(150)
    const u = new URL(s.calls[0]!.url)
    expect(u.searchParams.get("returnFieldsByFieldId")).toBe("true")
    expect(u.searchParams.get("sort[0][field]")).toBe(F.CREATED)
    expect(u.searchParams.get("filterByFormula")).toContain("{Merge-Status}=''")
    await c.updateRecords([{ id: "rec1", fields: { [F.MERGE_STATUS]: "ok" } }])
    const body = JSON.parse(String(s.calls[1]!.init!.body))
    expect(body).toEqual({ records: [{ id: "rec1", fields: { [F.MERGE_STATUS]: "ok" } }] })
    expect(body.typecast).toBeUndefined()
    expect(s.calls[1]!.at - s.calls[0]!.at).toBeGreaterThanOrEqual(500)
  })

  it("429: 30 s warten, max. 3 Versuche, dann Laufende", async () => {
    const clock = new FakeClock(NOW)
    const s = seq([json(429), json(429), json(429)])
    const c = new AirtableClient("pat", budget(clock), clock, s.make(clock))
    await expect(c.updateRecords([{ id: "rec1", fields: {} }])).rejects.toBeInstanceOf(AirtableAbort)
    expect(s.calls).toHaveLength(3)
    expect(s.calls[1]!.at - s.calls[0]!.at).toBe(30_000)
  })
})
