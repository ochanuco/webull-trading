// Narrow typings for the node built-ins test helpers use. Not @types/node:
// that would put Node globals in scope for src/ too, letting Worker code
// typecheck against APIs the Workers runtime doesn't have.

declare module 'node:fs' {
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:sqlite' {
  export type SQLInputValue = null | number | bigint | string | Uint8Array
  export interface StatementSync {
    all(...params: SQLInputValue[]): Array<Record<string, unknown>>
    get(...params: SQLInputValue[]): Record<string, unknown> | undefined
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}
