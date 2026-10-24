/** npm run dryrun -- --limit <n> [--records rec…,rec…]  → komplette Logik, schreibt NICHTS. */
import { createDeps } from "../src/factory"
import { runEnrichment } from "../src/run"
import { listArg, loadDevVars, parseArgs, timestamp, writeCsv, writeJson } from "./common"
import { reportRow } from "./report"

const args = parseArgs(process.argv.slice(2))
const limit = Number(args.limit ?? 20)
const recordIds = listArg(args.records)
const env = loadDevVars()
const deps = createDeps(env)
const ts = timestamp()

const { stats, reports } = await runEnrichment(deps, { mode: "dryrun", limit, recordIds })
const csv = writeCsv(`dryrun-${ts}.csv`, reports.map(reportRow))
const json = writeJson(`dryrun-${ts}.json`, { stats, reports })
console.log(JSON.stringify(stats, null, 2))
const notMain = reports.filter((r) => r.uuidIsMain === "nein")
if (notMain.length) console.log(`⚠ UUID ≠ Haupt-Call bei ${notMain.length} Protokoll(en): ${notMain.map((r) => r.recordId).join(", ")}`)
console.log(`Bericht: ${csv}\n         ${json}`)
