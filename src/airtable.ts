import { AIRTABLE, F, LIMITS, READ_FIELDS, SELECT_FORMULA } from "./config"
import { AirtableAbort, AuthError, Budget, Clock, FetchFn, Throttle, fetchWithTimeout } from "./http"

export interface ProtokollRecord {
  id: string
  createdTime: string
  fields: Record<string, unknown>
}

export interface RecordUpdate {
  id: string
  fields: Record<string, unknown>
}

export interface CandidatePage {
  records: ProtokollRecord[]
  /** Airtable-Cursor fuer die naechste Seite; fehlt = letzte Seite */
  offset?: string
}

export interface AirtableApi {
  listPage(offset?: string): Promise<CandidatePage>
  getRecord(id: string): Promise<ProtokollRecord | null>
  updateRecords(updates: RecordUpdate[]): Promise<void>
}

const TABLE_URL = `${AIRTABLE.API}/${AIRTABLE.BASE_ID}/${AIRTABLE.TABLE_ID}`

/**
 * Airtable-Client: max. 2 Requests/s (Base teilt sich 5/s mit dem PD),
 * Felder per ID (returnFieldsByFieldId), KEIN typecast.
 * 429 -> 30 s warten, max. 3 Versuche, danach Lauf beenden.
 */
export class AirtableClient implements AirtableApi {
  private throttle: Throttle

  constructor(
    private token: string,
    private budget: Budget,
    private clock: Clock,
    private fetchFn: FetchFn = (u, i) => fetch(u, i)
  ) {
    this.throttle = new Throttle(clock, LIMITS.AIRTABLE_MIN_INTERVAL_MS)
  }

  /** Eine Seite (max. 100) der Auswahl, nach Erstellzeit aufsteigend. */
  async listPage(offset?: string): Promise<CandidatePage> {
    const p = new URLSearchParams()
    p.set("filterByFormula", SELECT_FORMULA)
    p.set("sort[0][field]", F.CREATED)
    p.set("sort[0][direction]", "asc")
    p.set("pageSize", "100")
    p.set("returnFieldsByFieldId", "true")
    for (const f of READ_FIELDS) p.append("fields[]", f)
    if (offset) p.set("offset", offset)
    return this.request<CandidatePage>(`${TABLE_URL}?${p}`, { method: "GET" }, "read")
  }

  async getRecord(id: string): Promise<ProtokollRecord | null> {
    const p = new URLSearchParams({ returnFieldsByFieldId: "true" })
    try {
      return await this.request<ProtokollRecord>(`${TABLE_URL}/${encodeURIComponent(id)}?${p}`, { method: "GET" }, "read")
    } catch (e) {
      if (e instanceof AirtableAbort && /HTTP 404/.test(e.message)) return null
      throw e
    }
  }

  async updateRecords(updates: RecordUpdate[]): Promise<void> {
    if (updates.length === 0) return
    if (updates.length > LIMITS.AIRTABLE_BATCH) throw new Error("max. 10 Records pro Update")
    await this.request(
      `${TABLE_URL}?returnFieldsByFieldId=true`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // bewusst kein typecast: Merge-Status muss exakt einer Option entsprechen
        body: JSON.stringify({ records: updates }),
      },
      "write"
    )
  }

  private async request<T>(url: string, init: RequestInit, kind: "read" | "write"): Promise<T> {
    let last = ""
    for (let attempt = 1; attempt <= LIMITS.AIRTABLE_MAX_RETRIES; attempt++) {
      await this.throttle.wait()
      this.budget.take("airtable", kind)
      const res = await fetchWithTimeout(
        this.fetchFn,
        url,
        { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.token}` } },
        LIMITS.HTTP_TIMEOUT_MS
      )
      if (res && res.ok) return (await res.json()) as T
      if (res && (res.status === 401 || res.status === 403)) throw new AuthError("airtable", res.status)
      if (res && res.status === 429) {
        this.budget.counters.airtable429++
        last = "HTTP 429"
        if (attempt < LIMITS.AIRTABLE_MAX_RETRIES) await this.budget.sleep(LIMITS.AIRTABLE_429_WAIT_MS, kind)
        continue
      }
      if (res === null || res.status >= 500) {
        last = res === null ? "Timeout/Netzfehler" : `HTTP ${res.status}`
        if (attempt < LIMITS.AIRTABLE_MAX_RETRIES) await this.budget.sleep(5_000 * attempt, kind)
        continue
      }
      // 4xx (z. B. 422 ungueltige Select-Option) -> nicht wiederholen, Lauf beenden
      const body = await res.text().catch(() => "")
      throw new AirtableAbort(`Airtable HTTP ${res.status}: ${body.slice(0, 500)}`)
    }
    throw new AirtableAbort(`Airtable ${last} nach ${LIMITS.AIRTABLE_MAX_RETRIES} Versuchen`)
  }
}
