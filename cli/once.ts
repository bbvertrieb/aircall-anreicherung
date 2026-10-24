/**
 * npm run once -- --write --records rec…,rec…  → schreibt NUR diese Records.
 * Sichert vorher die aktuellen Werte der 5 Schreibfelder nach reports/backup-<ts>.json.
 */
import { WRITE_FIELDS } from "../src/config"
import { createDeps } from "../src/factory"
import { runEnrichment } from "../src/run"
import { listArg, loadDevVars, parseArgs, timestamp, writeCsv, writeJson } from "./common"
import { reportRow } from "./report"

const args = parseArgs(process.argv.slice(2))
const recordIds = listArg(args.records)
if (args.write !== true) {
  console.error("Abbruch: --write fehlt (ohne --write bitte npm run dryrun verwenden).")
  process.exit(1)
}
if (recordIds.length === 0) {
  console.error("Abbruch: --records rec…,rec… ist Pflicht – once schreibt nie per Auswahl.")
  process.exit(1)
}
if (recordIds.length > 10) {
  console.error("Abbruch: max. 10 Records pro Aufruf.")
  process.exit(1)
}

const env = loadDevVars()
const deps = createDeps(env)
const ts = timestamp()

const { stats, reports } = await runEnrichment(deps, {
  mode: "write",
  limit: recordIds.length,
  recordIds,
  beforeWrite: async (records) => {
    const backup = records.map((r) => ({
      id: r.id,
      fields: Object.fromEntries(WRITE_FIELDS.map((f) => [f, r.fields[f] ?? null])),
    }))
    const path = writeJson(`backup-${ts}.json`, { createdAt: new Date().toISOString(), records: backup })
    console.log(`Backup: ${path}`)
  },
})
const csv = writeCsv(`once-${ts}.csv`, reports.map(reportRow))
const json = writeJson(`once-${ts}.json`, { stats, reports })
console.log(JSON.stringify(stats, null, 2))
console.log(`Bericht: ${csv}\n         ${json}`)
