/**
 * Kopie von src/lib/phone.ts aus bbvertrieb/powerdialer – Logik identisch halten!
 *
 * Telefonnummer-Helfer fuer die Call-Zuordnung (nur Vergleich, keine Formatierung).
 *
 * Aircall liefert "to" uneinheitlich ("+49 1512 1719265" ODER "+4915121719265"),
 * die App haelt E.164 und nationale Nummern. Der Vergleich normalisiert auf
 * reine Ziffern und toleriert verschiedene Praefix-Schreibweisen.
 */

/**
 * Reduziert auf reine Ziffern und raeumt Praefixe auf:
 * - fuehrendes "00" (internationales Praefix) entfernen,
 * - "490..." am Anfang -> "49..." (Altformat "+49 0 151…"),
 * - fuehrende "0" im nationalen Format bleibt unveraendert.
 */
export function normDigits(s: string | null | undefined): string {
  if (!s) return ""
  let d = String(s).replace(/\D/g, "")
  if (d.startsWith("00")) d = d.slice(2)
  if (d.startsWith("490")) d = "49" + d.slice(3)
  return d
}

/**
 * `true`, wenn zwei Nummern dieselbe sind: entweder normalisiert gleich ODER
 * beide mindestens 9 Ziffern und in den letzten 9 Ziffern gleich (deckt
 * E.164 vs. nationales Format ab). Leere/ungueltige Werte -> `false`.
 */
export function samePhone(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const da = normDigits(a)
  const db = normDigits(b)
  if (!da || !db) return false
  if (da === db) return true
  if (da.length >= 9 && db.length >= 9 && da.slice(-9) === db.slice(-9)) {
    return true
  }
  return false
}
