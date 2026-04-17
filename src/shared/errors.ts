export class BrokerRequestError extends Error {
  readonly broker = 'webull'
  override readonly cause?: unknown

  constructor(
    message: string,
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = 'BrokerRequestError'
    this.cause = options?.cause
  }
}
