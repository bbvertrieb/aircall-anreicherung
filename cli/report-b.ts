import type { TeilBReport } from "../src/teilbRun"

const wien = (iso: string | number | null | undefined) =>
  iso == null || iso === ""
    ? ""
    : new Date(typeof iso === "number" ? iso * 1000 : iso).toLocaleString("de-AT", { timeZone: "Europe/Vienna" })

/** Eine CSV-Zeile je Protokoll (Teil B), inkl. Pruefdetails. */
export function reportRowB(r: TeilBReport): Record<string, unknown> {
  const p = r.plan
  const c = r.call
  const chk = (id: string) => {
    const x = r.checks.find((k) => k.id === id)
    return x ? `${x.ok ? "ok" : "NEIN"}: ${x.detail}` : ""
  }
  return {
    recordId: r.recordId,
    Bereich: r.range,
    Firma: r.firma,
    "Erstellt (Wien)": wien(r.createdTime),
    UUID: r.uuid,
    "Call gefunden": c === undefined ? "–" : c === null ? "nein (404)" : "ja",
    "Call Start (Wien)": wien(c?.started_at),
    "Aircall raw_digits": c?.raw_digits ?? "",
    "Aircall Leitung": c?.number ? `${c.number.id ?? ""} ${c.number.name ?? ""}`.trim() : "",
    "Aircall User": c?.user?.name ?? "",
    direction: c?.direction ?? "",
    answered: c ? (c.answered_at ? "ja" : "nein") : "",
    duration: c?.duration ?? "",
    "Protokoll-Nummern": r.numbers,
    P1: chk("P1"),
    P2: chk("P2"),
    P3: chk("P3"),
    P4: chk("P4"),
    P5: chk("P5"),
    Aktion: p.kind === "write" ? (r.written ? "geschrieben" : "würde schreiben") : "unverändert",
    "Status (geplant)": p.kind === "write" ? p.status : "",
    "Merge-Fehler / Grund": p.kind === "write" ? p.notes.join(" | ") : p.reason,
    "Felder geplant": p.kind === "write" ? Object.keys(p.fields).join(", ") : "",
    "Dauer (Sek)": p.kind === "write" ? (p.duration ?? "") : "",
    "Zeichen Summary": p.kind === "write" ? (p.summary?.length ?? 0) : "",
    "Zeichen Transkript": p.kind === "write" ? (p.transcript?.length ?? 0) : "",
  }
}
