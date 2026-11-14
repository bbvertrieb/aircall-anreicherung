/**
 * Cloudflare Worker: nur scheduled-Handler (kein fetch-Handler, keine URL).
 * Notfall-Schalter: Variable ENABLED != "true" -> sofort beenden.
 */
import { Env, readSettings } from "./config"
import { createDeps } from "./factory"
import { RunStats, runEnrichment } from "./run"
import { runTeilB } from "./teilbRun"
import { checkWindow } from "./time"

interface ScheduledEventLike {
  scheduledTime: number
  cron: string
}

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ worker: "aircall-anreicherung", ...obj }))
}

export async function scheduledRun(env: Env, now: Date = new Date()): Promise<void> {
  const settings = readSettings(env)
  if (!settings.enabled) {
    log({ start: now.toISOString(), abortReason: "ENABLED != true" })
    return
  }
  let win
  try {
    win = checkWindow(now, settings)
  } catch (e) {
    log({ start: now.toISOString(), abortReason: `Zeitfenster-Konfiguration: ${(e as Error).message}` })
    return
  }
  if (!win.allowed) {
    log({ start: now.toISOString(), local: win.local, abortReason: `Zeitfenster: ${win.reason}` })
    return
  }
  let deps
  try {
    deps = createDeps(env, win.msRemaining)
  } catch (e) {
    log({ start: now.toISOString(), abortReason: (e as Error).message })
    return
  }
  const { stats } = await runEnrichment(deps, { mode: settings.mode, limit: settings.maxRecords })
  log({ local: win.local, ...stats })

  // Teil B (Altbestand) nur, wenn eingeschaltet und Teil A Kapazitaet uebrig laesst.
  if (settings.teilbMax > 0 && settings.teilbRanges.length > 0) {
    const reason = teilbBlocked(stats, settings.maxRecords)
    if (reason) {
      log({ teil: "B", local: win.local, ranges: settings.teilbRanges, abortReason: reason })
      return
    }
    const b = await runTeilB(deps, { mode: settings.mode, limit: settings.teilbMax, ranges: settings.teilbRanges })
    log({ local: win.local, ...b.stats })
  }
}

/** Teil A hat Vorrang: Teil B nur, wenn Teil A sauber durch ist und sein Limit nicht ausgeschoepft hat. */
export function teilbBlocked(a: RunStats, maxRecords: number): string | null {
  if (a.abortReason) return `Teil A beendet mit: ${a.abortReason}`
  if (a.processed >= maxRecords) return "keine Kapazität: Teil A hat sein Limit ausgeschöpft"
  return null
}

export default {
  async scheduled(_event: ScheduledEventLike, env: Env): Promise<void> {
    await scheduledRun(env)
  },
}
