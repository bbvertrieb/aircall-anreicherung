/** Gemeinsame Bausteine: Uhr, Budget (Zeit + Subrequests), Fehlerklassen, Drossel. */

export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
}

/** Zugang ungueltig (401/403) -> Lauf sofort abbrechen. */
export class AuthError extends Error {
  constructor(public service: "airtable" | "aircall", public status: number) {
    super(`${service}: Zugang verweigert (HTTP ${status})`)
  }
}

/** 429/5xx/Timeout nach allen Retries -> Protokoll unveraendert lassen. */
export class TransientError extends Error {
  constructor(public service: "airtable" | "aircall", msg: string) {
    super(`${service}: ${msg}`)
  }
}

/** Airtable: 429 nach 3 Versuchen oder anderer harter Fehler -> Lauf beenden. */
export class AirtableAbort extends Error {}

/** Zeit- oder Request-Budget erschoepft -> sauber aufhoeren. */
export class BudgetExceeded extends Error {}

export interface Counters {
  airtable: number
  aircall: number
  airtable429: number
  aircall429: number
}

export class Budget {
  readonly counters: Counters = { airtable: 0, aircall: 0, airtable429: 0, aircall429: 0 }

  constructor(
    private clock: Clock,
    /** Absoluter Endzeitpunkt (ms). */
    readonly deadline: number,
    readonly maxSubrequests: number,
    private readReserveMs: number,
    private readReserveRequests: number
  ) {}

  get used(): number {
    return this.counters.airtable + this.counters.aircall
  }

  msLeft(): number {
    return this.deadline - this.clock.now()
  }

  /** Darf ein neues Protokoll begonnen werden? */
  canStart(reserveMs: number, reserveRequests: number): boolean {
    return this.msLeft() >= reserveMs && this.used + reserveRequests <= this.maxSubrequests
  }

  /**
   * Vor jedem Request aufrufen. Lese-Requests halten eine Reserve frei, damit
   * gesammelte Updates am Ende noch geschrieben werden koennen.
   */
  take(service: "airtable" | "aircall", kind: "read" | "write"): void {
    const reserveMs = kind === "read" ? this.readReserveMs : 0
    const reserveReq = kind === "read" ? this.readReserveRequests : 0
    if (this.msLeft() < reserveMs) throw new BudgetExceeded("Laufzeit-Grenze erreicht")
    if (this.used + 1 + reserveReq > this.maxSubrequests) {
      throw new BudgetExceeded("Subrequest-Grenze erreicht")
    }
    this.counters[service]++
  }

  /** Warten nur, wenn es noch ins Budget passt. */
  async sleep(ms: number, kind: "read" | "write"): Promise<void> {
    const reserveMs = kind === "read" ? this.readReserveMs : 0
    if (this.msLeft() - ms < reserveMs) throw new BudgetExceeded("Wartezeit passt nicht mehr ins Laufzeit-Budget")
    await this.clock.sleep(ms)
  }
}

/** Mindestabstand zwischen zwei Request-Starts. */
export class Throttle {
  private last = -Infinity
  constructor(private clock: Clock, private minIntervalMs: number) {}
  async wait(): Promise<void> {
    const delta = this.clock.now() - this.last
    if (delta < this.minIntervalMs) await this.clock.sleep(this.minIntervalMs - delta)
    this.last = this.clock.now()
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** fetch mit Timeout; Timeout/Netzfehler -> null. */
export async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetchFn(url, { ...init, signal: ac.signal })
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}
