export class HttpError extends Error {
  constructor(
    public status: number,
    public retryAt: number,
    public service: string,
  ) {
    super(`${service} returned HTTP ${status}`);
    this.name = "HttpError";
  }
}
const cooldowns = new Map<string, number>();
export async function requestJson(
  url: string,
  init: RequestInit = {},
  service = "upstream",
  beforeAttempt?: () => void | Promise<void>,
): Promise<any> {
  const blocked = cooldowns.get(service) ?? 0;
  if (blocked > Date.now()) throw new HttpError(429, blocked, service);
  for (let attempt = 0; attempt < 3; attempt++) {
    await beforeAttempt?.();
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      const seconds =
        retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : null;
      const retryAt = Math.max(
        Date.now() + 1000,
        seconds !== null
          ? Date.now() + seconds * 1000
          : Date.parse(retry ?? "") || Date.now() + 60000,
      );
      cooldowns.set(service, retryAt);
      throw new HttpError(429, retryAt, service);
    }
    if (response.ok) return response.json();
    if (response.status < 500 || attempt === 2)
      throw new HttpError(response.status, 0, service);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw new Error("Request exhausted");
}
