export class BrowserDriverError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BrowserDriverError';
    this.error_code = code;
  }
}

export function buildError(err, op) {
  const message = typeof err === 'string' ? err
    : err?.message || err?.error || 'Unknown error';
  const code = err?.error_code;
  const error = new BrowserDriverError(
    op ? `${op}: ${message}` : message,
    code
  );
  return error;
}

export function assertNoError(result, op) {
  if (result && typeof result === 'object' && 'error' in result && result.error != null) {
    throw buildError(result, op);
  }
  return result;
}
