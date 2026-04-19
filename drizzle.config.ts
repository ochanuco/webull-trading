import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/infrastructure/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  // `wrangler d1 migrations apply` が D1 側に流すので、drizzle 自身の
  // credentials は持たない (SQL ファイル生成のみ)。
})
