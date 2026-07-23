export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public ctx?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
  }
}
