import type { RecordReport } from "../src/run"

/** Eine CSV-Zeile je Protokoll. */
export function reportRow(r: RecordReport): Record<string, unknown> {
  const p = r.plan
  return {
    recordId: r.recordId,
    Firma: r.firma,
    Calls: r.callIds.join(", "),
    Nummern: r.numbers.join(", "),
    "Nummern-Check": r.numberCheck,
    Aktion: p.kind === "write" ? (r.written ? "geschrieben" : "würde schreiben") : "unverändert",
    "Status (geplant)": p.kind === "write" ? p.status : "",
    "Merge-Fehler / Grund": p.kind === "write" ? p.notes.join(" | ") : p.reason,
    "Dauer (Sek)": p.kind === "write" ? (p.duration ?? "") : "",
    "Zeichen Summary": p.kind === "write" ? (p.summary?.length ?? 0) : "",
    "Zeichen Transkript": p.kind === "write" ? (p.transcript?.length ?? 0) : "",
    "UUID gespeichert": r.uuid,
    "Haupt-Call erwartet": r.expectedMainCall ?? "",
    "UUID=Haupt-Call": r.uuidIsMain,
  }
}
