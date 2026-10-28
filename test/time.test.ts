import { describe, expect, it } from "vitest"
import { readSettings } from "../src/config"
import { checkWindow, parseRanges, viennaHHMM } from "../src/time"

const cfg = { windowStart: "21:00", windowEnd: "05:00", skipWindows: "02:30-03:15" }
const at = (iso: string) => checkWindow(new Date(iso), cfg)

describe("checkWindow (Europe/Vienna)", () => {
  it("Sommerzeit: Fenster 21:00–05:00", () => {
    expect(at("2026-10-20T18:40:00Z")).toMatchObject({ allowed: false, local: "20:40" })
    expect(at("2026-10-20T19:00:00Z")).toMatchObject({ allowed: true, local: "21:00" })
    expect(at("2026-10-20T22:20:00Z")).toMatchObject({ allowed: true, local: "00:20" })
    expect(at("2026-10-21T02:40:00Z")).toMatchObject({ allowed: true, local: "04:40" })
    expect(at("2026-10-21T03:00:00Z")).toMatchObject({ allowed: false, local: "05:00" })
  })
  it("Sperrfenster 02:30–03:15 (Nachlauf Kunde 02:47)", () => {
    expect(at("2026-10-21T00:20:00Z")).toMatchObject({ allowed: true, local: "02:20" })
    expect(at("2026-10-21T00:40:00Z")).toMatchObject({ allowed: false, local: "02:40" })
    expect(at("2026-10-21T01:00:00Z")).toMatchObject({ allowed: false, local: "03:00" })
    expect(at("2026-10-21T01:20:00Z")).toMatchObject({ allowed: true, local: "03:20" })
  })
  it("Restzeit endet vor dem Sperrfenster bzw. Fensterende", () => {
    expect(at("2026-10-21T00:20:00Z").msRemaining).toBe(10 * 60_000) // 02:20 -> 02:30
    expect(at("2026-10-21T02:40:00Z").msRemaining).toBe(20 * 60_000) // 04:40 -> 05:00
    expect(at("2026-10-20T19:00:00Z").msRemaining).toBe(5.5 * 3600_000) // 21:00 -> 02:30
  })
  it("Winterzeit: gleiche lokale Zeiten bei anderer UTC-Zeit", () => {
    expect(at("2026-11-02T20:00:00Z")).toMatchObject({ allowed: true, local: "21:00" })
    expect(at("2026-11-02T19:40:00Z")).toMatchObject({ allowed: false, local: "20:40" })
    expect(at("2026-11-03T01:40:00Z")).toMatchObject({ allowed: false, local: "02:40" })
    expect(at("2026-11-03T03:40:00Z")).toMatchObject({ allowed: true, local: "04:40" })
  })
  it("Tag der Zeitumstellung 25.10.2026 (03:00 CEST -> 02:00 CET)", () => {
    // Cron-Laeufe in UTC, lokale Wiener Zeit:
    expect(at("2026-10-25T00:20:00Z")).toMatchObject({ allowed: true, local: "02:20" }) // CEST
    expect(at("2026-10-25T00:40:00Z")).toMatchObject({ allowed: false, local: "02:40" }) // CEST, Sperre
    expect(at("2026-10-25T01:00:00Z")).toMatchObject({ allowed: true, local: "02:00" }) // CET, Stunde wiederholt
    expect(at("2026-10-25T01:20:00Z")).toMatchObject({ allowed: true, local: "02:20" }) // CET
    expect(at("2026-10-25T01:40:00Z")).toMatchObject({ allowed: false, local: "02:40" }) // CET, Sperre (Nachlauf 02:47 CET)
    expect(at("2026-10-25T02:00:00Z")).toMatchObject({ allowed: false, local: "03:00" })
    expect(at("2026-10-25T02:20:00Z")).toMatchObject({ allowed: true, local: "03:20" })
    expect(at("2026-10-25T03:40:00Z")).toMatchObject({ allowed: true, local: "04:40" })
    expect(at("2026-10-25T04:00:00Z")).toMatchObject({ allowed: false, local: "05:00" })
    // Abend danach (CET): Cron 19:xx UTC = 20:xx lokal -> ausserhalb, 20:00 UTC = 21:00
    expect(at("2026-10-25T19:40:00Z")).toMatchObject({ allowed: false, local: "20:40" })
    expect(at("2026-10-25T20:00:00Z")).toMatchObject({ allowed: true, local: "21:00" })
  })
  it("Cron-Stunden 19-23,0-3 UTC decken das Fenster in Sommer- und Winterzeit ab", () => {
    const cronHoursUtc = [19, 20, 21, 22, 23, 0, 1, 2, 3]
    for (const day of ["2026-07-15", "2026-12-15"]) {
      const allowedLocal = new Set<string>()
      for (const h of cronHoursUtc) {
        for (const m of [0, 20, 40]) {
          const base = new Date(`${day}T00:00:00Z`)
          if (h >= 19) base.setUTCDate(base.getUTCDate() - 1)
          base.setUTCHours(h, m)
          const w = checkWindow(base, cfg)
          if (w.allowed) allowedLocal.add(w.local)
        }
      }
      expect(allowedLocal.has("21:00")).toBe(true)
      expect(allowedLocal.has("04:40")).toBe(true)
      expect(allowedLocal.has("02:20")).toBe(true)
      expect(allowedLocal.has("03:20")).toBe(true)
    }
  })
  it("Fenster 18:00–06:00 über Mitternacht; Cron */15 16-23,0-4 UTC deckt es in Sommer- und Winterzeit ab", () => {
    const c = { windowStart: "18:00", windowEnd: "06:00", skipWindows: "02:30-03:15" }
    const w = (iso: string) => checkWindow(new Date(iso), c)
    // Winterzeit (UTC+1)
    expect(w("2026-11-02T16:45:00Z")).toMatchObject({ allowed: false, local: "17:45" })
    expect(w("2026-11-02T17:00:00Z")).toMatchObject({ allowed: true, local: "18:00" })
    expect(w("2026-11-02T23:15:00Z")).toMatchObject({ allowed: true, local: "00:15" })
    expect(w("2026-11-03T04:45:00Z")).toMatchObject({ allowed: true, local: "05:45" })
    expect(w("2026-11-03T04:45:00Z").msRemaining).toBe(15 * 60_000) // 05:45 -> 06:00
    expect(w("2026-11-03T05:00:00Z")).toMatchObject({ allowed: false, local: "06:00" })
    // Sommerzeit (UTC+2)
    expect(w("2026-07-15T15:45:00Z")).toMatchObject({ allowed: false, local: "17:45" })
    expect(w("2026-07-15T16:00:00Z")).toMatchObject({ allowed: true, local: "18:00" })
    expect(w("2026-07-16T03:45:00Z")).toMatchObject({ allowed: true, local: "05:45" })
    expect(w("2026-07-16T04:00:00Z")).toMatchObject({ allowed: false, local: "06:00" })
    // Restzeit 18:00 -> Sperrfenster 02:30
    expect(w("2026-11-02T17:00:00Z").msRemaining).toBe(8.5 * 3600_000)

    const cronHoursUtc = [16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4]
    for (const day of ["2026-07-15", "2026-12-15"]) {
      const allowedLocal = new Set<string>()
      for (const h of cronHoursUtc) {
        for (const m of [0, 15, 30, 45]) {
          const base = new Date(`${day}T00:00:00Z`)
          if (h >= 16) base.setUTCDate(base.getUTCDate() - 1)
          base.setUTCHours(h, m)
          const r = checkWindow(base, c)
          if (r.allowed) allowedLocal.add(r.local)
        }
      }
      for (const t of ["18:00", "23:45", "00:00", "02:15", "03:15", "05:45"]) expect(allowedLocal.has(t)).toBe(true)
      for (const t of ["02:30", "02:45", "03:00", "17:45", "06:00"]) expect(allowedLocal.has(t)).toBe(false)
    }
  })
  it("Variablen: anderes Fenster, keine Sperren, Fehler bei Unsinn", () => {
    const c = { windowStart: "08:00", windowEnd: "18:00", skipWindows: "" }
    expect(checkWindow(new Date("2026-10-20T10:00:00Z"), c)).toMatchObject({ allowed: true, local: "12:00" })
    expect(checkWindow(new Date("2026-10-20T17:00:00Z"), c).allowed).toBe(false)
    expect(parseRanges("02:30-03:15, 04:00-04:10")).toHaveLength(2)
    expect(() => checkWindow(new Date(), { ...c, windowStart: "8 Uhr" })).toThrow()
  })
  it("viennaHHMM", () => {
    expect(viennaHHMM(new Date("2026-03-29T00:59:00Z"))).toBe("01:59")
    expect(viennaHHMM(new Date("2026-03-29T01:00:00Z"))).toBe("03:00") // Sommerzeit-Beginn
  })
})

describe("readSettings (Notfall-Schalter)", () => {
  it("Defaults sind sicher", () => {
    expect(readSettings({})).toMatchObject({ enabled: false, mode: "dryrun", maxRecords: 150, windowStart: "21:00", windowEnd: "05:00", skipWindows: "02:30-03:15" })
  })
  it("nur exakt true/write schaltet scharf", () => {
    expect(readSettings({ ENABLED: "TRUE", MODE: "write" })).toMatchObject({ enabled: true, mode: "write" })
    expect(readSettings({ ENABLED: "yes", MODE: "Write!" })).toMatchObject({ enabled: false, mode: "dryrun" })
    expect(readSettings({ MAX_RECORDS_PER_RUN: "abc" }).maxRecords).toBe(150)
    expect(readSettings({ SKIP_WINDOWS: "" }).skipWindows).toBe("")
  })
})
