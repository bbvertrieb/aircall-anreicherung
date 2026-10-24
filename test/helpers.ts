import type { AircallApi, AircallCall } from "../src/aircall"
import type { AirtableApi, ProtokollRecord, RecordUpdate } from "../src/airtable"
import { F, LIMITS } from "../src/config"
import { AuthError, Budget, Clock, TransientError } from "../src/http"

/** Virtuelle Uhr: sleep() rueckt nur die Zeit vor. */
export class FakeClock implements Clock {
  constructor(public t: number) {}
  now() {
    return this.t
  }
  async sleep(ms: number) {
    this.t += ms
  }
}

export const NOW = Date.UTC(2026, 9, 24, 20, 0) // 22:00 Wien
export const H = 3600

export function call(id: number, o: Partial<AircallCall> = {}): AircallCall {
  return {
    id,
    direction: "outbound",
    raw_digits: "+49 1512 1719265",
    duration: 120,
    started_at: NOW / 1000 - 20 * H,
    answered_at: NOW / 1000 - 20 * H + 10,
    ended_at: NOW / 1000 - 20 * H + 120,
    ...o,
  }
}

export function record(id: string, lines: string[], fields: Record<string, unknown> = {}): ProtokollRecord {
  return {
    id,
    createdTime: "2026-10-23T08:00:00.000Z",
    fields: { [F.AIRCALL_CALLS]: lines.join("\n"), [F.FIRMA]: `Firma ${id}`, [F.CALL_UUID]: lines[0]?.split("|")[0]?.trim(), ...fields },
  }
}

export const line = (id: number, num = "+4915121719265") => `${id} | ${num} | 2026-10-23T08:00:00.000Z`

type Ai = { transcript?: unknown; summary?: unknown }

export class FakeAircall implements AircallApi {
  requests: string[] = []
  constructor(
    public calls: Record<string, AircallCall | null | "transient" | "auth">,
    public ai: Record<string, Ai> = {},
    private budget?: Budget
  ) {}
  private hit(path: string) {
    this.budget?.take("aircall", "read")
    this.requests.push(path)
  }
  async getCall(id: string) {
    this.hit(`/calls/${id}`)
    const c = this.calls[id]
    if (c === "transient") throw new TransientError("aircall", "HTTP 503")
    if (c === "auth") throw new AuthError("aircall", 401)
    return c ?? null
  }
  async getTranscription(id: string) {
    this.hit(`/calls/${id}/transcription`)
    return this.ai[id]?.transcript ?? null
  }
  async getSummary(id: string) {
    this.hit(`/calls/${id}/summary`)
    return this.ai[id]?.summary ?? null
  }
}

export class FakeAirtable implements AirtableApi {
  updates: RecordUpdate[][] = []
  constructor(public records: ProtokollRecord[], private budget?: Budget) {}
  pageSize = 100
  pagesLoaded = 0
  async listPage(offset?: string) {
    this.budget?.take("airtable", "read")
    this.pagesLoaded++
    const from = offset ? Number(offset) : 0
    const to = from + this.pageSize
    return { records: this.records.slice(from, to), offset: to < this.records.length ? String(to) : undefined }
  }
  async getRecord(id: string) {
    this.budget?.take("airtable", "read")
    return this.records.find((r) => r.id === id) ?? null
  }
  async updateRecords(u: RecordUpdate[]) {
    this.budget?.take("airtable", "write")
    this.updates.push(u)
  }
}

export function budget(clock: Clock, maxSub: number = LIMITS.MAX_SUBREQUESTS, runtime: number = LIMITS.MAX_RUNTIME_MS) {
  return new Budget(clock, clock.now() + runtime, maxSub, LIMITS.READ_RESERVE_MS, LIMITS.READ_RESERVE_REQUESTS)
}

export const tr = (...texts: string[]) => ({
  transcription: { content: { utterances: texts.map((t, i) => ({ participant_type: i % 2 ? "external" : "internal", text: t })) } },
})
export const su = (text: string) => ({ summary: { content: text } })
