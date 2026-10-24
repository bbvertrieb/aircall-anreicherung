/** npm run probe -- --calls <id,id,…>  → nur lesen: je Call answered, duration, Transkript/Summary (Zeichen). */
import { AuthError } from "../src/http"
import { needsAi } from "../src/rules"
import { createDeps } from "../src/factory"
import { summaryToText, transcriptToText } from "../src/text"
import { listArg, loadDevVars, parseArgs, timestamp, writeCsv } from "./common"

const args = parseArgs(process.argv.slice(2))
const ids = listArg(args.calls)
if (ids.length === 0) {
  console.error("Aufruf: npm run probe -- --calls <id,id,…>")
  process.exit(1)
}
const { aircall } = createDeps(loadDevVars())
const rows: Record<string, unknown>[] = []
for (const id of ids) {
  try {
    const call = await aircall.getCall(id)
    if (!call) {
      rows.push({ callId: id, gefunden: "nein (404)" })
      continue
    }
    let tr = "nicht abgefragt"
    let su = "nicht abgefragt"
    if (needsAi(call)) {
      const t = await aircall.getTranscription(id)
      const s = await aircall.getSummary(id)
      tr = t ? String(transcriptToText(t).length) : "404"
      su = s ? String(summaryToText(s).length) : "404"
    }
    rows.push({
      callId: id,
      gefunden: "ja",
      direction: call.direction ?? "",
      raw_digits: call.raw_digits ?? "",
      answered: call.answered_at ? "ja" : "nein",
      duration: call.duration ?? "",
      started_at: call.started_at ? new Date(call.started_at * 1000).toISOString() : "",
      "Transkript (Zeichen)": tr,
      "Summary (Zeichen)": su,
    })
  } catch (e) {
    if (e instanceof AuthError) throw e
    rows.push({ callId: id, gefunden: `Fehler: ${(e as Error).message}` })
  }
  console.log(JSON.stringify(rows[rows.length - 1]))
}
console.log(`Bericht: ${writeCsv(`probe-${timestamp()}.csv`, rows)}`)
