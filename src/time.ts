/**
 * Zeitfenster in Europe/Vienna. Die Cron-Zeiten sind UTC; durch die
 * Sommerzeit-Umstellung verschiebt sich die lokale Uhrzeit – deshalb prueft
 * der Worker die lokale Zeit selbst.
 */

export const TZ = "Europe/Vienna"

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

/** Lokale Uhrzeit in Wien als Sekunden seit Mitternacht. */
export function viennaSecondOfDay(d: Date): number {
  const parts = fmt.formatToParts(d)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0")
  return get("hour") * 3600 + get("minute") * 60 + get("second")
}

/** "HH:MM" in Wien. */
export function viennaHHMM(d: Date): string {
  const s = viennaSecondOfDay(d)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/** "HH:MM" -> Minuten seit Mitternacht. Wirft bei ungueltigem Format. */
export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) throw new Error(`Ungueltige Uhrzeit: "${s}"`)
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`Ungueltige Uhrzeit: "${s}"`)
  return h * 60 + min
}

interface Range {
  start: number // Minute, inklusiv
  end: number // Minute, exklusiv
}

/** "02:30-03:15,04:00-04:10" -> Bereiche. Leerer String = keine. */
export function parseRanges(s: string): Range[] {
  return s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [a, b] = p.split("-")
      if (!a || !b) throw new Error(`Ungueltiges Zeitfenster: "${p}"`)
      return { start: parseHHMM(a), end: parseHHMM(b) }
    })
}

/** Liegt die Sekunde im (ggf. ueber Mitternacht laufenden) Bereich? */
function inRange(sec: number, r: Range): boolean {
  const s = r.start * 60
  const e = r.end * 60
  return s <= e ? sec >= s && sec < e : sec >= s || sec < e
}

/** Sekunden bis zum Ende des Bereichs (sec muss im Bereich liegen). */
function secondsUntil(sec: number, minute: number): number {
  const t = minute * 60
  return t > sec ? t - sec : t + 86400 - sec
}

export interface WindowConfig {
  windowStart: string
  windowEnd: string
  skipWindows: string
}

export interface WindowCheck {
  allowed: boolean
  local: string
  /** Wenn erlaubt: Millisekunden bis das Fenster endet oder ein Skip-Fenster beginnt. */
  msRemaining: number
  reason?: string
}

/**
 * Darf zum Zeitpunkt `now` gearbeitet werden? Liefert zusaetzlich, wie lange
 * noch – damit ein Lauf nicht in "Nachlauf Kunde" (02:47) hineinlaeuft.
 * Hinweis: In der Nacht der Zeitumstellung kann der Rest um bis zu 1 h
 * ueberschaetzt werden; die feste Laufzeitgrenze (12 Min) faengt das ab.
 */
export function checkWindow(now: Date, cfg: WindowConfig): WindowCheck {
  const sec = viennaSecondOfDay(now)
  const local = viennaHHMM(now)
  const main: Range = { start: parseHHMM(cfg.windowStart), end: parseHHMM(cfg.windowEnd) }
  const skips = parseRanges(cfg.skipWindows)
  if (!inRange(sec, main)) {
    return { allowed: false, local, msRemaining: 0, reason: `ausserhalb ${cfg.windowStart}–${cfg.windowEnd}` }
  }
  const skip = skips.find((r) => inRange(sec, r))
  if (skip) {
    return { allowed: false, local, msRemaining: 0, reason: `Sperrfenster ${cfg.skipWindows}` }
  }
  let rem = secondsUntil(sec, main.end)
  for (const r of skips) rem = Math.min(rem, secondsUntil(sec, r.start))
  return { allowed: true, local, msRemaining: rem * 1000 }
}
