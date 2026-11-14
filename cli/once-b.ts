/**
 * npm run once-b -- --write --records rec…,rec…  → Teil B, schreibt NUR diese Records (max. 10).
 * Sichert vorher die 5 Schreibfelder nach reports/backup-b-<ts>.json (Format wie `restore`).
 */
import { WRITE_FIELDS } from "../src/config"
import { createDeps } from "../src/factory"
import { runTeilB } from "../src/teilbRun"
import { listArg, loadDevVars, parseArgs, timestamp, writeCsv, writeJson } from "./common"
import { reportRowB } from "./report-b"

const args = parseArgs(process.argv.slice(2))
const recordIds = listArg(args.records)
if (args.write !== true) {
  console.error("Abbruch: --write fehlt (ohne --write bitte npm run dryrun-b verwenden).")
  process.exit(1)
}
if (recordIds.length === 0 || recordIds.length > 10) {
  console.error("Abbruch: --records rec…,rec… ist Pflicht (max. 10).")
  process.exit(1)
}

const deps = createDeps(loadDevVars())
const ts = timestamp()
const { stats, reports } = await runTeilB(deps, {
  mode: "write",
  limit: recordIds.length,
  ranges: [],
  recordIds,
  beforeWrite: async (records) => {
    const backup = records.map((r) => ({
      id: r.id,
      fields: Object.fromEntries(WRITE_FIELDS.map((f) => [f, r.fields[f] ?? null])),
    }))
    console.log(`Backup: ${writeJson(`backup-b-${ts}.json`, { createdAt: new Date().toISOString(), records: backup })}`)
  },
})
const csv = writeCsv(`once-b-${ts}.csv`, reports.map(reportRowB))
const json = writeJson(`once-b-${ts}.json`, { stats, reports })
console.log(JSON.stringify(stats, null, 2))
console.log(`Bericht: ${csv}\n         ${json}`)
