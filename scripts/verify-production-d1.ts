import { readFileSync } from 'node:fs'

const configPath = process.argv[2] ?? 'wrangler.jsonc'
const wrangler = readFileSync(configPath, 'utf8')
const prodBlock = wrangler.match(/"production"\s*:\s*\{[\s\S]*?"d1_databases"\s*:\s*\[[\s\S]*?\{([\s\S]*?)\}[\s\S]*?\]/)
const databaseName = prodBlock?.[1]?.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1] ?? null
const databaseId = prodBlock?.[1]?.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1] ?? null

const failures: string[] = []
if (databaseName !== 'webull-trading-production') {
  failures.push(`expected production database_name=webull-trading-production, got ${databaseName ?? '<missing>'}`)
}
if (!databaseId || databaseId === 'REPLACE_WITH_PRODUCTION_ID') {
  failures.push('production database_id is missing or still set to REPLACE_WITH_PRODUCTION_ID')
}

if (failures.length > 0) {
  console.error(`Production D1 verification failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log(`Production D1 binding looks configured: ${databaseName} (${databaseId})`)
