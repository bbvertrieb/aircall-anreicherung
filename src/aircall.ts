import { AIRCALL_API, LIMITS } from "./config"
import { AuthError, Budget, Clock, FetchFn, Throttle, TransientError, fetchWithTimeout } from "./http"

export interface AircallCall {
  id: number | string
  direction?: string | null
  raw_digits?: string | null
  duration?: number | null
  /** Unix-Sekunden */
  started_at?: number | null
  answered_at?: number | null
  ended_at?: number | null
}

/** Ergebnis eines GET: `null` = 404 (nicht vorhanden). */
export interface AircallApi {
  getCall(id: string): Promise<AircallCall | null>
  getTranscription(id: string): Promise<unknown | null>
  getSummary(id: string): Promise<unknown | null>
}

/**
 * Aircall-Client: max. 1 Request pro 1,2 s (Firmenlimit 60/min ist geteilt).
 * 429 -> Retry-After (sonst 60 s), 5xx/Timeout -> kurzer Backoff; je max. 3 Retries.
 */
export class AircallClient implements AircallApi {
  private throttle: Throttle
  private auth: string | null

  /** apiId/apiToken `null` = Auth haengt ein Proxy an (CLI im Cloud-Modus). */
  constructor(
    apiId: string | null,
    apiToken: string | null,
    private budget: Budget,
    private clock: Clock,
    private fetchFn: FetchFn = (u, i) => fetch(u, i)
  ) {
    this.throttle = new Throttle(clock, LIMITS.AIRCALL_MIN_INTERVAL_MS)
    this.auth = apiId && apiToken ? "Basic " + btoa(`${apiId}:${apiToken}`) : null
  }

  getCall(id: string): Promise<AircallCall | null> {
    return this.get<{ call?: AircallCall }>(`/calls/${encodeURIComponent(id)}`).then((r) => r?.call ?? null)
  }

  getTranscription(id: string): Promise<unknown | null> {
    return this.get(`/calls/${encodeURIComponent(id)}/transcription`)
  }

  getSummary(id: string): Promise<unknown | null> {
    return this.get(`/calls/${encodeURIComponent(id)}/summary`)
  }

  private async get<T>(path: string): Promise<T | null> {
    let lastErr = ""
    for (let attempt = 0; attempt <= LIMITS.AIRCALL_MAX_RETRIES; attempt++) {
      await this.throttle.wait()
      this.budget.take("aircall", "read")
      const res = await fetchWithTimeout(
        this.fetchFn,
        AIRCALL_API + path,
        { headers: { ...(this.auth ? { Authorization: this.auth } : {}), Accept: "application/json" } },
        LIMITS.HTTP_TIMEOUT_MS
      )
      if (res === null) {
        lastErr = "Timeout/Netzfehler"
      } else if (res.ok) {
        return (await res.json()) as T
      } else if (res.status === 404) {
        return null
      } else if (res.status === 401 || res.status === 403) {
        throw new AuthError("aircall", res.status)
      } else if (res.status === 429) {
        this.budget.counters.aircall429++
        lastErr = "HTTP 429"
        if (attempt < LIMITS.AIRCALL_MAX_RETRIES) {
          await this.budget.sleep(retryAfterMs(res.headers.get("Retry-After"), this.clock), "read")
        }
        continue
      } else if (res.status >= 500) {
        lastErr = `HTTP ${res.status}`
      } else {
        // 4xx sonst: nicht wiederholbar, als Fehler des Calls behandeln
        throw new TransientError("aircall", `HTTP ${res.status} bei ${path}`)
      }
      if (attempt < LIMITS.AIRCALL_MAX_RETRIES) await this.budget.sleep(5_000 * (attempt + 1), "read")
    }
    throw new TransientError("aircall", `${lastErr} bei ${path} (nach ${LIMITS.AIRCALL_MAX_RETRIES} Retries)`)
  }
}

/** Retry-After: Sekunden oder HTTP-Datum; sonst 60 s. */
export function retryAfterMs(h: string | null, clock: Clock): number {
  if (h) {
    const s = Number(h)
    if (Number.isFinite(s) && s >= 0) return Math.max(1_000, s * 1000)
    const d = Date.parse(h)
    if (Number.isFinite(d)) return Math.max(1_000, d - clock.now())
  }
  return LIMITS.AIRCALL_429_DEFAULT_WAIT_MS
}
