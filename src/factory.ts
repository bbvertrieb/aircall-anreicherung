import { AircallClient } from "./aircall"
import { AirtableClient } from "./airtable"
import { Env, LIMITS } from "./config"
import { Budget, Clock, realClock } from "./http"
import type { Deps } from "./run"

type Secrets = Pick<Env, "AIRTABLE_TOKEN" | "AIRCALL_API_ID" | "AIRCALL_API_TOKEN">

/**
 * Clients + Budget fuer einen Lauf. `maxRuntimeMs` begrenzt zusaetzlich (z. B. Zeitfenster-Ende).
 * `env = null`: keine Secrets, kein eigener Authorization-Header – die Auth haengt ein Proxy an
 * (nur CLI in der Cloud-Umgebung; der Worker braucht die Secrets immer).
 */
export function createDeps(env: Secrets | null, maxRuntimeMs: number = LIMITS.MAX_RUNTIME_MS, clock: Clock = realClock): Deps {
  if (env) {
    for (const k of ["AIRTABLE_TOKEN", "AIRCALL_API_ID", "AIRCALL_API_TOKEN"] as const) {
      if (!env[k]) throw new Error(`Secret ${k} fehlt`)
    }
  }
  const budget = new Budget(
    clock,
    clock.now() + Math.min(maxRuntimeMs, LIMITS.MAX_RUNTIME_MS),
    LIMITS.MAX_SUBREQUESTS,
    LIMITS.READ_RESERVE_MS,
    LIMITS.READ_RESERVE_REQUESTS
  )
  return {
    budget,
    clock,
    airtable: new AirtableClient(env?.AIRTABLE_TOKEN ?? null, budget, clock),
    aircall: new AircallClient(env?.AIRCALL_API_ID ?? null, env?.AIRCALL_API_TOKEN ?? null, budget, clock),
  }
}
