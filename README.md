# aircall-anreicherung

Cloudflare Worker (nur Cron, keine URL), der nachts Aircall-Daten in die Airtable-Tabelle
**PROTOKOLLE** (`app8uGokICeSrE4FO` / `tblO7sHXwS0KaisMD`) schreibt:
Call Duration, AI Summary, Transkript, Merge-Status, Merge-Fehler.
Der Worker ist der **einzige Schreiber** auf diesen Feldern; der Power-Dialer liest sie nur.

## Notfall-Schalter

Im Cloudflare-Dashboard → Worker → Settings → Variables:

| Variable | Default (im Code) | Wirkung |
|---|---|---|
| `ENABLED` | `false` | alles außer exakt `true` → Lauf endet sofort |
| `MODE` | `dryrun` | nur exakt `write` schreibt; sonst wird nur geloggt |
| `MAX_RECORDS_PER_RUN` | `150` | max. ausgewählte Protokolle je Lauf |
| `WINDOW_START` / `WINDOW_END` | `21:00` / `05:00` | Arbeitsfenster, Uhrzeit Europe/Vienna |
| `SKIP_WINDOWS` | `02:30-03:15` | Sperrfenster (Komma-getrennt), `""` = keine |

`wrangler.jsonc` enthält **keinen** `vars`-Block und `keep_vars: true` – ein Deploy überschreibt
die Dashboard-Werte also nicht. Fehlt eine Variable, gelten die sicheren Defaults.

Secrets (setzt Leo): `wrangler secret put AIRTABLE_TOKEN`, `AIRCALL_API_ID`, `AIRCALL_API_TOKEN`.

## Zeitplan & Schutz

- Cron (UTC) `*/20 19-23,0-3 * * *`; der Worker prüft selbst die Wiener Uhrzeit
  (Sommer-/Winterzeit) und arbeitet nur 21:00–05:00, nicht 02:30–03:15 („Nachlauf Kunde" 02:47).
- Je Lauf max. 12 Min und 800 Subrequests; endet außerdem vor Beginn des Sperrfensters/Fensterendes.
  Neue Protokolle werden nur begonnen, wenn ≥ 90 s und ≥ 40 Requests übrig sind → keine Überlappung.
- Airtable: max. 2 Req/s, Batches à 10, 429 → 30 s warten, max. 3 Versuche, dann Laufende.
- Aircall: max. 1 Req/1,2 s, 429 → Retry-After (sonst 60 s), max. 3 Retries.
- 401/403 → Lauf sofort abbrechen. 429/5xx/Timeout nach Retries → Protokoll bleibt unverändert.
- Je Lauf eine JSON-Logzeile (Workers Observability).

## Verarbeitung je Protokoll (Kurzfassung)

Auswahl: `{Aircall Calls}` gefüllt, `{Merge-Status}` leer, älter als 2 h, nach Erstellzeit aufsteigend.
`MAX_RECORDS_PER_RUN` zählt nur **verarbeitete** Protokolle (Status geplant/geschrieben). Unverändert
gelassene (z. B. AI noch nicht da, 5xx) zählen als `skipped` im Lauf-Log; der Lauf blättert weiter,
bis das Limit erreicht, die Auswahl zu Ende oder das Budget aufgebraucht ist.

1. Nummer jeder Zeile ↔ `raw_digits` (Logik aus `powerdialer/src/lib/phone.ts`) und `direction = outbound`,
   sonst nur **prüfen** + Merge-Fehler. Call 404 → **fehler**.
2. AI Summary/Transkript schon befüllt → **prüfen** („Felder bereits befüllt – nicht überschrieben").
3. Dauer = Summe aller `duration` (inkl. Klingelzeit). Kein Call beantwortet → **kein Gespräch**.
4. AI nur für beantwortete Calls ≥ 30 s. Ein Call mit Inhalt → Text pur; mehrere →
   Kopfzeile `── HH:MM · Nummer · M:SS Min ──` je Call, chronologisch. > 95.000 Zeichen → gekürzt.
5. Ohne Transkript/Summary: Call < 12 h → nächster Lauf; sonst **ok** + Hinweis.
6. Bericht (nicht geschrieben): ist die gespeicherte UUID der längste beantwortete Call?

## Lokale Befehle (gleicher Kern-Code, Secrets aus `.dev.vars`)

```bash
cp .dev.vars.example .dev.vars          # Secrets eintragen (gitignored)
npm install
npm run probe  -- --calls 123,456                 # nur lesen → reports/probe-<ts>.csv
npm run dryrun -- --limit 20 [--records recA,recB] # schreibt nichts; --limit = verarbeitete → reports/dryrun-<ts>.csv/.json
npm run once   -- --write --records recA,recB      # schreibt NUR diese (max. 10), Backup vorher
```

Ohne `.dev.vars` werden die drei Secrets aus Umgebungsvariablen gelesen. Fehlen alle drei und ist
`HTTPS_PROXY` gesetzt (Cloud-Umgebung mit Network secrets), senden die CLI-Clients keinen eigenen
`Authorization`-Header – der Proxy hängt die Auth an. Der Worker verlangt die Secrets weiterhin.

`once` sichert vorher die 5 Schreibfelder nach `reports/backup-<ts>.json` und überspringt Records,
deren Merge-Status schon gesetzt ist. Die lokalen Befehle ignorieren `ENABLED`/`MODE`/Zeitfenster.

## Entwicklung

```bash
npx tsc --noEmit
npm test
npm run deploy:check   # wrangler build ohne Upload
```
