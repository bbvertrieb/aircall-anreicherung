import { describe, expect, it } from "vitest"
import type { AirtableApi, RecordUpdate } from "../src/airtable"
import { F, WRITE_FIELDS } from "../src/config"
import { buildRestoreUpdates, restore } from "../src/restore"

const backup = {
  createdAt: "2026-10-24T20:00:00.000Z",
  records: [
    { id: "recA", fields: { [F.DURATION]: null, [F.AI_SUMMARY]: null, [F.TRANSKRIPT]: "", [F.MERGE_STATUS]: null, [F.MERGE_FEHLER]: null } },
    { id: "recB", fields: { [F.DURATION]: 42, [F.AI_SUMMARY]: "alt", [F.TRANSKRIPT]: "t", [F.MERGE_STATUS]: "prüfen", [F.MERGE_FEHLER]: "x", [F.FIRMA]: "nicht zurückschreiben" } },
    { id: "recC", fields: {} },
  ],
}

describe("restore", () => {
  it("nur die 5 Schreibfelder; leer/fehlend -> null (Feld leeren); Werte unverändert", () => {
    const u = buildRestoreUpdates(backup, ["recA", "recB", "recC"])
    expect(u).toEqual([
      { id: "recA", fields: Object.fromEntries(WRITE_FIELDS.map((f) => [f, null])) },
      { id: "recB", fields: { [F.DURATION]: 42, [F.AI_SUMMARY]: "alt", [F.TRANSKRIPT]: "t", [F.MERGE_STATUS]: "prüfen", [F.MERGE_FEHLER]: "x" } },
      { id: "recC", fields: Object.fromEntries(WRITE_FIELDS.map((f) => [f, null])) },
    ])
  })

  it("nur angegebene Records; Pflicht, max. 10, alle müssen im Backup stehen", () => {
    expect(buildRestoreUpdates(backup, ["recB"]).map((u) => u.id)).toEqual(["recB"])
    expect(() => buildRestoreUpdates(backup, [])).toThrow(/Pflicht/)
    expect(() => buildRestoreUpdates(backup, Array.from({ length: 11 }, (_, i) => `rec${i}`))).toThrow(/max\. 10/)
    expect(() => buildRestoreUpdates(backup, ["recA", "recX"])).toThrow(/Nicht im Backup: recX/)
  })

  it("schreibt über updateRecords (ohne typecast)", async () => {
    const sent: RecordUpdate[][] = []
    const at: AirtableApi = {
      listPage: async () => ({ records: [] }),
      getRecord: async () => null,
      updateRecords: async (u) => void sent.push(u),
    }
    await restore(at, buildRestoreUpdates(backup, ["recA", "recB"]))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.map((u) => u.id)).toEqual(["recA", "recB"])
  })
})
