/** Hilfen fuer die lokalen Testbefehle (Node). Secrets aus .dev.vars. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Env } from "../src/config"

export function loadDevVars(path = ".dev.vars"): Env {
  if (!existsSync(path)) throw new Error(`${path} fehlt (Vorlage: .dev.vars.example)`)
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith("#")) continue
    env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2")
  }
  return env as unknown as Env
}

/** Minimaler Arg-Parser: --flag, --key value, --key=value. */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out[a.slice(2)] = argv[++i]!
    else out[a.slice(2)] = true
  }
  return out
}

export function listArg(v: string | true | undefined): string[] {
  if (typeof v !== "string") return []
  return v.split(",").map((s) => s.trim()).filter(Boolean)
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("Z", "")
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV mit Semikolon (Excel DE) und BOM. */
export function writeCsv(file: string, rows: Record<string, unknown>[]): string {
  const path = reportPath(file)
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const text = [headers, ...rows.map((r) => headers.map((h) => r[h]))].map((r) => r.map(csvCell).join(";")).join("\n")
  writeFileSync(path, "﻿" + text + "\n", "utf8")
  return path
}

export function writeJson(file: string, data: unknown): string {
  const path = reportPath(file)
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8")
  return path
}

function reportPath(file: string): string {
  mkdirSync("reports", { recursive: true })
  return join("reports", file)
}
