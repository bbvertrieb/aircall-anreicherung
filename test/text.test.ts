import { describe, expect, it } from "vitest"
import { TRUNCATE_SUFFIX } from "../src/config"
import { blockHeader, formatMinSec, mergeBlocks, parseCallLines, summaryToText, transcriptToText, truncate } from "../src/text"

describe("parseCallLines", () => {
  it("liest Zeilen, ignoriert Leerzeilen und Duplikate", () => {
    const p = parseCallLines("111 | +4915121719265 | 2026-10-20T08:00:00.000Z\n\n  \n222|+43664123|2026-10-20T08:05:00Z\n111 | +4915121719265 | x\n")
    expect(p.invalid).toEqual([])
    expect(p.lines.map((l) => [l.callId, l.number, l.iso])).toEqual([
      ["111", "+4915121719265", "2026-10-20T08:00:00.000Z"],
      ["222", "+43664123", "2026-10-20T08:05:00Z"],
    ])
  })
  it("markiert Zeilen ohne numerische Call-ID", () => {
    const p = parseCallLines("abc | +49 | x\n333 | +49 | y")
    expect(p.invalid).toEqual(["abc | +49 | x"])
    expect(p.lines).toHaveLength(1)
  })
  it("leer/undefined", () => {
    expect(parseCallLines(undefined).lines).toEqual([])
  })
})

describe("transcriptToText", () => {
  const utt = [
    { participant_type: "internal", text: "Guten Tag" },
    { participant_type: "external", text: "  Hallo " },
    { participant_type: "external", text: "" },
  ]
  it("Format 1: transcription.content.utterances (richtiger Pfad)", () => {
    expect(transcriptToText({ transcription: { id: 1, content: { language: "de", utterances: utt } } })).toBe(
      "[internal] Guten Tag\n[external] Hallo"
    )
  })
  it("Format 2 (Fallback): transcription.utterances", () => {
    expect(transcriptToText({ transcription: { utterances: utt } })).toBe("[internal] Guten Tag\n[external] Hallo")
  })
  it("Fallback: String content", () => {
    expect(transcriptToText({ transcription: { content: "  Freitext  " } })).toBe("Freitext")
  })
  it("leer / unbekannt", () => {
    expect(transcriptToText(null)).toBe("")
    expect(transcriptToText({ transcription: {} })).toBe("")
    expect(transcriptToText({ transcription: { content: { utterances: [] } } })).toBe("")
  })
  it("fehlender participant_type", () => {
    expect(transcriptToText({ transcription: { content: { utterances: [{ text: "x" }] } } })).toBe("[unbekannt] x")
  })
})

describe("summaryToText", () => {
  it("summary.content", () => {
    expect(summaryToText({ summary: { content: " Kurzfassung " } })).toBe("Kurzfassung")
    expect(summaryToText({ summary: {} })).toBe("")
    expect(summaryToText(null)).toBe("")
  })
})

describe("mergeBlocks", () => {
  // 2026-10-20 08:05:00 UTC = 10:05 Wien (Sommerzeit)
  const a = { startedAt: Date.UTC(2026, 9, 20, 8, 5) / 1000, number: "+4915121719265", duration: 245, text: "A-Text" }
  const b = { startedAt: Date.UTC(2026, 9, 20, 7, 50) / 1000, number: "+43664123", duration: 61, text: "B-Text" }
  it("genau ein Block mit Inhalt -> ohne Kopfzeile", () => {
    expect(mergeBlocks([a, { ...b, text: "  " }])).toBe("A-Text")
  })
  it("mehrere -> Kopfzeilen, chronologisch, Leerzeile dazwischen", () => {
    expect(mergeBlocks([a, b])).toBe(
      "── 09:50 · +43664123 · 1:01 Min ──\nB-Text\n\n── 10:05 · +4915121719265 · 4:05 Min ──\nA-Text"
    )
  })
  it("keiner -> leer", () => {
    expect(mergeBlocks([])).toBe("")
  })
  it("Kopfzeile im Winter (CET)", () => {
    expect(blockHeader({ startedAt: Date.UTC(2026, 10, 2, 8, 5) / 1000, number: "1", duration: 9, text: "" })).toBe(
      "── 09:05 · 1 · 0:09 Min ──"
    )
  })
})

describe("truncate / formatMinSec", () => {
  it("bis 95.000 unveraendert, darueber gekuerzt + Hinweis", () => {
    const ok = "x".repeat(95_000)
    expect(truncate(ok)).toEqual({ text: ok, truncated: false })
    const long = truncate("y".repeat(95_001))
    expect(long.truncated).toBe(true)
    expect(long.text).toBe("y".repeat(95_000) + TRUNCATE_SUFFIX)
    expect(long.text.endsWith("\n[… gekürzt, vollständig in Aircall]")).toBe(true)
  })
  it("M:SS", () => {
    expect(formatMinSec(0)).toBe("0:00")
    expect(formatMinSec(65)).toBe("1:05")
    expect(formatMinSec(3725)).toBe("62:05")
  })
})
