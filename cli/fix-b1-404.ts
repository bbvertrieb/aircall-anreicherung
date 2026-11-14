/**
 * Einmal-Korrektur (Teil B): B1-Protokolle mit Call 404, in denen schon alte n8n-Daten stehen,
 * wurden vor der Regel-Anpassung auf "fehler" gesetzt. Neu: "prüfen" + B1_NOT_FOUND_OLD_DATA.
 *   npm run fix-b1-404                → nur Liste/Anzahl (schreibt nichts)
 *   npm run fix-b1-404 -- --write     → Backup der 5 Felder, dann nur Merge-Status + Merge-Fehler
 * Erfasst nur: "Aircall Calls" leer, Merge-Status "fehler", Erstellzeit vor Ende B1,
 * Merge-Fehler = 404-Text von Teil B, Dauer/AI Summary/Transkript befuellt.
 */
import { AirtableClient, ProtokollRecord } from "../src/airtable"
import { AIRTABLE, F, LIMITS, WRITE_FIELDS } from "../src/config"
import { Budget, realClock } from "../src/http"
import { notFoundNote } from "../src/rules"
import { B1_NOT_FOUND_OLD_DATA, RANGES, hasOldData } from "../src/teilbRules"
import { loadDevVars, parseArgs, timestamp, writeCsv, writeJson } from "./common"

const args = parseArgs(process.argv.slice(2))
const write = args.write === true
const env = loadDevVars()
const budget = new Budget(realClock, realClock.now() + 3600_000, 100_000, LIMITS.READ_RESERVE_MS, LIMITS.READ_RESERVE_REQUESTS)
const airtable = new AirtableClient(env?.AIRTABLE_TOKEN ?? null, budget, realClock)
const ts = timestamp()
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v))

const formula = `AND({Aircall Calls}='', {Merge-Status}='fehler', IS_BEFORE(CREATED_TIME(), '${RANGES.B1.to}'))`
const all: ProtokollRecord[] = []
let offset: string | undefined
do {
  const page = await airtable.query(AIRTABLE.TABLE_ID, {
    formula,
    fields: [...WRITE_FIELDS, F.CALL_UUID, F.AIRCALL_CALLS, F.FIRMA],
    sortField: F.CREATED,
    offset,
  })
  all.push(...page.records)
  offset = page.offset
} while (offset)

const isB404 = (r: ProtokollRecord) => str(r.fields[F.MERGE_FEHLER]).trim() === notFoundNote(str(r.fields[F.CALL_UUID]).trim())
const hits = all.filter((r) => !str(r.fields[F.AIRCALL_CALLS]).trim() && isB404(r) && hasOldData(r))
const otherNote = all.filter((r) => !isB404(r))
console.log(`fehler ohne "Aircall Calls", vor Ende B1: ${all.length}`)
console.log(`  davon 404-Text von Teil B + alte Daten (werden korrigiert): ${hits.length}`)
console.log(`  davon 404 ohne alte Daten (bleiben fehler): ${all.filter((r) => isB404(r) && !hasOldData(r)).length}`)
console.log(`  davon anderer Merge-Fehler (nicht angefasst): ${otherNote.length}`)

const len = (v: unknown) => str(v).length
const rows = hits.map((r) => ({
  recordId: r.id,
  Firma: [r.fields[F.FIRMA]].flat().map(str).join(", "),
  Erstellt: r.createdTime,
  UUID: str(r.fields[F.CALL_UUID]),
  "Dauer (alt)": str(r.fields[F.DURATION]),
  "Zeichen Summary (alt)": len(r.fields[F.AI_SUMMARY]),
  "Zeichen Transkript (alt)": len(r.fields[F.TRANSKRIPT]),
  "Merge-Fehler bisher": str(r.fields[F.MERGE_FEHLER]),
  "Merge-Status neu": "prüfen",
  "Merge-Fehler neu": B1_NOT_FOUND_OLD_DATA,
}))
console.log(`Liste: ${writeCsv(`fix-b1-404-${ts}.csv`, rows)}`)

if (write && hits.length) {
  const backup = hits.map((r) => ({ id: r.id, fields: Object.fromEntries(WRITE_FIELDS.map((f) => [f, r.fields[f] ?? null])) }))
  console.log(`Backup: ${writeJson(`backup-fix-b1-404-${ts}.json`, { createdAt: new Date().toISOString(), records: backup })}`)
  for (let i = 0; i < hits.length; i += LIMITS.AIRTABLE_BATCH) {
    await airtable.updateRecords(
      hits.slice(i, i + LIMITS.AIRTABLE_BATCH).map((r) => ({
        id: r.id,
        fields: { [F.MERGE_STATUS]: "prüfen", [F.MERGE_FEHLER]: B1_NOT_FOUND_OLD_DATA },
      }))
    )
  }
  console.log(`geschrieben: ${hits.length} (nur Merge-Status + Merge-Fehler)`)
} else if (!write) {
  console.log("Dryrun – nichts geschrieben.")
}
