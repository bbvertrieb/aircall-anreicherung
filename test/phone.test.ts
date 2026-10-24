import { describe, expect, it } from "vitest"
import { normDigits, samePhone } from "../src/phone"

describe("normDigits", () => {
  it("entfernt alles ausser Ziffern, fuehrendes 00 und 490 -> 49", () => {
    expect(normDigits("+49 1512 1719265")).toBe("4915121719265")
    expect(normDigits("0049 151 21719265")).toBe("4915121719265")
    expect(normDigits("+49 (0) 151 21719265")).toBe("4915121719265")
    expect(normDigits("0151 21719265")).toBe("015121719265")
    expect(normDigits(null)).toBe("")
  })
})

describe("samePhone", () => {
  it("E.164 vs. Aircall-Leerzeichen-Format", () => {
    expect(samePhone("+4915121719265", "+49 1512 1719265")).toBe(true)
  })
  it("E.164 vs. national (letzte 9 Ziffern)", () => {
    expect(samePhone("+4915121719265", "015121719265")).toBe(true)
    expect(samePhone("+43 1 5123456", "01 5123456")).toBe(false) // Wiener Festnetz: letzte 9 Ziffern "315123456" ≠ "015123456" (bekannte Grenze, wie im PD)
  })
  it("Oesterreich/Schweiz", () => {
    expect(samePhone("+43 664 1234567", "0664 1234567")).toBe(true)
    expect(samePhone("0041 44 123 45 67", "+41441234567")).toBe(true)
  })
  it("verschiedene Nummern / leere Werte", () => {
    expect(samePhone("+4915121719265", "+4915121719266")).toBe(false)
    expect(samePhone("", "+4915121719265")).toBe(false)
    expect(samePhone("+49151", undefined)).toBe(false)
  })
  it("kurze Nummern nur bei exakter Gleichheit", () => {
    expect(samePhone("12345678", "12345678")).toBe(true)
    expect(samePhone("912345678", "812345678")).toBe(false)
  })
})
