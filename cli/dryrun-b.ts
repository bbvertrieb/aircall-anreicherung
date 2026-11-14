/**
 * Teil B, schreibt NICHTS:
 *   npm run dryrun-b -- --range B1 --limit 200 [--sample]
 *   npm run dryrun-b -- --records rec…,rec…
 * Aircall-Limit teilt sich die Firma: nur abends/am Wochenende laufen lassen.
 */
import { parseTeilbRanges } from "../src/config"
import { createDeps } from "../src/factory"
import { runTeilB } from "../src/teilbRun"
import { listArg, loadDevVars, parseArgs, timestamp, writeCsv, writeJson } from "./common"
import { reportRowB } from "./report-b"

const args = parseArgs(process.argv.slice(2))
const recordIds = listArg(args.records)
const ranges = parseTeilbRanges(typeof args.range === "string" ? args.range : "")
if (!recordIds.length && !ranges.length) {
  console.error("Aufruf: npm run dryrun-b -- --range B1|B2|B1,B2 --limit <n> [--sample]  oder  --records rec…,rec…")
  process.exit(1)
}
const limit = Number(args.limit ?? (recordIds.length || 20))
const deps = createDeps(loadDevVars())
const ts = timestamp()

const { stats, reports } = await runTeilB(deps, { mode: "dryrun", limit, ranges, recordIds, sample: args.sample === true, sampleSlices: args.slices ? Number(args.slices) : undefined })
const csv = writeCsv(`dryrun-b-${ts}.csv`, reports.map(reportRowB))
const json = writeJson(`dryrun-b-${ts}.json`, { stats, reports })
console.log(JSON.stringify(stats, null, 2))
console.log(`Bericht: ${csv}\n         ${json}`)
