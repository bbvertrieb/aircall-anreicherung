import { LIMITS, TRUNCATE_SUFFIX } from "./config"
import { viennaHHMM } from "./time"

export interface CallLine {
  callId: string
  number: string
  iso: string
  raw: string
}

export interface ParsedCalls {
  lines: CallLine[]
  /** Nicht lesbare Zeilen (z. B. ohne Call-ID). */
  invalid: string[]
}

/** "Aircall Calls": je Zeile "<callId> | <gewählte Nummer> | <ISO-Zeit>", leere Zeilen ignorieren. */
export function parseCallLines(text: unknown): ParsedCalls {
  const lines: CallLine[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw) continue
    const [id = "", number = "", iso = ""] = raw.split("|").map((s) => s.trim())
    if (!/^\d+$/.test(id)) {
      invalid.push(raw)
      continue
    }
    if (seen.has(id)) continue // doppelte Zeile: Call nur einmal zaehlen
    seen.add(id)
    lines.push({ callId: id, number, iso, raw })
  }
  return { lines, invalid }
}

/**
 * Transkript aus der Aircall-Antwort.
 * Primaer: transcription.content.utterances[] (hier lag der n8n-Fehler),
 * Fallback: transcription.utterances[], dann String transcription.content.
 */
export function transcriptToText(resp: unknown): string {
  const r = resp as Record<string, any> | null | undefined
  const tr = (r?.transcription ?? r) as Record<string, any> | null | undefined
  if (!tr || typeof tr !== "object") return ""
  const utterances = Array.isArray(tr.content?.utterances)
    ? tr.content.utterances
    : Array.isArray(tr.utterances)
      ? tr.utterances
      : null
  if (utterances) {
    return sortByStartTime(utterances)
      .map((u: any) => {
        const text = String(u?.text ?? "").trim()
        if (!text) return ""
        return `[${String(u?.participant_type ?? "unbekannt")}] ${text}`
      })
      .filter(Boolean)
      .join("\n")
  }
  if (typeof tr.content === "string") return tr.content.trim()
  return ""
}

/**
 * Aircall liefert die Utterances fast chronologisch; bei gleichzeitigem Sprechen kann eine
 * spaeter begonnene vor einer frueheren stehen. Stabil nach start_time sortieren; Eintraege
 * ohne numerische start_time behalten die Position ihres Vorgaengers.
 */
function sortByStartTime(utterances: any[]): any[] {
  let last = -Infinity
  return utterances
    .map((u, i) => {
      const t = Number(u?.start_time)
      if (u?.start_time != null && Number.isFinite(t)) last = t
      return { u, i, t: last }
    })
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.u)
}

/** summary.content (String). */
export function summaryToText(resp: unknown): string {
  const r = resp as Record<string, any> | null | undefined
  const c = r?.summary?.content
  return typeof c === "string" ? c.trim() : ""
}

/** Sekunden -> "M:SS". */
export function formatMinSec(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export interface TextBlock {
  /** Unix-Sekunden, fuer Sortierung und Kopfzeile */
  startedAt: number
  number: string
  duration: number
  text: string
}

export function blockHeader(b: TextBlock): string {
  return `── ${viennaHHMM(new Date(b.startedAt * 1000))} · ${b.number} · ${formatMinSec(b.duration)} Min ──`
}

/**
 * Bloecke zusammenfuehren: nur Bloecke mit Inhalt. Genau einer -> Text ohne
 * Kopfzeile; mehrere -> je Kopfzeile, chronologisch, Leerzeile dazwischen.
 */
export function mergeBlocks(blocks: TextBlock[]): string {
  const withText = blocks.filter((b) => b.text.trim() !== "")
  if (withText.length === 0) return ""
  if (withText.length === 1) return withText[0]!.text.trim()
  return [...withText]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((b) => `${blockHeader(b)}\n${b.text.trim()}`)
    .join("\n\n")
}

/** Laenger als 95.000 Zeichen -> abschneiden + Hinweis. */
export function truncate(text: string, max: number = LIMITS.MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + TRUNCATE_SUFFIX, truncated: true }
}
