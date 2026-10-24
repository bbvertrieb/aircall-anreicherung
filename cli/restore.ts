/**
 * npm run restore -- --backup reports/backup-<ts>.json --records rec…,rec…
 * Schreibt die gesicherten Werte der 5 Schreibfelder zurueck (max. 10 Records, ohne typecast).
 * Leere Werte leeren das Feld. Sichert vorher den aktuellen Stand nach reports/prerestore-<ts>.json.
 */
import { readFileSync } from "node:fs"
import { WRITE_FIELDS } from "../src/config"
import { createDeps } from "../src/factory"
import { Backup, buildRestoreUpdates, restore } from "../src/restore"
import { listArg, loadDevVars, parseArgs, timestamp, writeJson } from "./common"

const args = parseArgs(process.argv.slice(2))
if (typeof args.backup !== "string") {
  console.error("Aufruf: npm run restore -- --backup <datei> --records rec…,rec…")
  process.exit(1)
}
let updates
try {
  updates = buildRestoreUpdates(JSON.parse(readFileSync(args.backup, "utf8")) as Backup, listArg(args.records))
} catch (e) {
  console.error(`Abbruch: ${(e as Error).message}`)
  process.exit(1)
}

const { airtable } = createDeps(loadDevVars())
const ts = timestamp()
const current = []
for (const u of updates) {
  const r = await airtable.getRecord(u.id)
  if (!r) {
    console.error(`Abbruch: Record ${u.id} nicht gefunden – nichts geschrieben.`)
    process.exit(1)
  }
  current.push({ id: r.id, fields: Object.fromEntries(WRITE_FIELDS.map((f) => [f, r.fields[f] ?? null])) })
}
console.log(`Stand vor Rückbau: ${writeJson(`prerestore-${ts}.json`, { createdAt: new Date().toISOString(), records: current })}`)
await restore(airtable, updates)
for (const u of updates) console.log(JSON.stringify(u))
console.log(`Zurückgeschrieben: ${updates.length} Record(s)`)
