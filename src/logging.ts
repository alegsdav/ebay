// Deliberately log event metadata, not provider response bodies, tokens, titles or prompts.
export function log(event: string, metadata: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...metadata }),
  );
}
export function errorKind(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}
