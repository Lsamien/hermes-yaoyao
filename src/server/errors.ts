export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'request_failed',
  ) {
    super(message)
  }
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : 'Unexpected server error'
}
