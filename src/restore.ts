/** Rueckbau aus einem Backup von `once`: setzt die 5 Schreibfelder auf die gesicherten Werte. */
import type { AirtableApi, RecordUpdate } from "./airtable"
import { LIMITS, WRITE_FIELDS } from "./config"

export interface Backup {
  createdAt?: string
  records: { id: string; fields: Record<string, unknown> }[]
}

export const MAX_RESTORE_RECORDS = 10

/**
 * Updates fuer genau die angegebenen Records. Nur die 5 Schreibfelder; leere Werte
 * (fehlend, null, "") -> null, d. h. das Feld wird geleert. Wirft, wenn ein Record
 * nicht im Backup steht oder das Limit ueberschritten ist.
 */
export function buildRestoreUpdates(backup: Backup, recordIds: string[]): RecordUpdate[] {
  if (recordIds.length === 0) throw new Error("--records rec…,rec… ist Pflicht")
  if (recordIds.length > MAX_RESTORE_RECORDS) throw new Error(`max. ${MAX_RESTORE_RECORDS} Records pro Aufruf`)
  if (!Array.isArray(backup?.records)) throw new Error("Backup-Datei hat kein records-Array")
  const byId = new Map(backup.records.map((r) => [r.id, r]))
  const missing = recordIds.filter((id) => !byId.has(id))
  if (missing.length) throw new Error(`Nicht im Backup: ${missing.join(", ")}`)
  return [...new Set(recordIds)].map((id) => {
    const saved = byId.get(id)!.fields ?? {}
    const fields: Record<string, unknown> = {}
    for (const f of WRITE_FIELDS) {
      const v = saved[f]
      fields[f] = v == null || v === "" ? null : v
    }
    return { id, fields }
  })
}

/** Schreibt die Updates in Batches à 10 (ohne typecast, s. AirtableClient). */
export async function restore(airtable: AirtableApi, updates: RecordUpdate[]): Promise<void> {
  for (let i = 0; i < updates.length; i += LIMITS.AIRTABLE_BATCH) {
    await airtable.updateRecords(updates.slice(i, i + LIMITS.AIRTABLE_BATCH))
  }
}
