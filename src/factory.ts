import { AircallClient } from "./aircall"
import { AirtableClient } from "./airtable"
import { Env, LIMITS } from "./config"
import { Budget, Clock, realClock } from "./http"
import type { Deps } from "./run"

/** Clients + Budget fuer einen Lauf. `maxRuntimeMs` begrenzt zusaetzlich (z. B. Zeitfenster-Ende). */
export function createDeps(env: Pick<Env, "AIRTABLE_TOKEN" | "AIRCALL_API_ID" | "AIRCALL_API_TOKEN">, maxRuntimeMs: number = LIMITS.MAX_RUNTIME_MS, clock: Clock = realClock): Deps {
  for (const k of ["AIRTABLE_TOKEN", "AIRCALL_API_ID", "AIRCALL_API_TOKEN"] as const) {
    if (!env[k]) throw new Error(`Secret ${k} fehlt`)
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
    airtable: new AirtableClient(env.AIRTABLE_TOKEN, budget, clock),
    aircall: new AircallClient(env.AIRCALL_API_ID, env.AIRCALL_API_TOKEN, budget, clock),
  }
}
