/**
 * DeepSeek balance reader for the Matrix Terminal prompt line.
 *
 * One authenticated Host route asks the DeepSeek platform for the wallets
 * behind the configured API key. The key is resolved per request, used for a
 * single outbound call, and never leaves this process: the browser receives
 * decimal strings only.
 */

/** Route below the shared `/api` channel; only authenticated owner peers reach it. */
const ROUTE = '/api/matrix-terminal.balance';
/** Documented API-key balance endpoint. */
const ENDPOINT = 'https://api.deepseek.com/user/balance';
/** Reference the DeepSeek provider resolves for inference, so both read the same key. */
const CREDENTIAL = 'DEEPSEEK_API_KEY';
/** Repeated focus reads answer from this window instead of spending a request each time. */
const CACHE_MS = 30000;
/** A balance read that hangs must not hold the route open. */
const TIMEOUT_MS = 8000;

/**
 * Install the balance route.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  /** Last successful answer and the moment it was measured. */
  let cached;
  /** The read currently in flight, shared by concurrent requests. */
  let pending;

  /** Resolve the API key through the credential service, or undefined when unset. */
  const resolveKey = async () => {
    const credentials = ctx.get('credentials');
    if (credentials === undefined) return undefined;
    try {
      const hit = await credentials.resolve(CREDENTIAL);
      return hit === undefined ? undefined : hit.value;
    } catch {
      return undefined;
    }
  };

  /** Read the wallets behind the key, or an explicit reason why no amount exists. */
  const read = async () => {
    if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.payload;
    if (pending !== undefined) return pending;
    pending = (async () => {
      const key = await resolveKey();
      if (key === undefined) return { ok: false, reason: 'no-key' };
      let response;
      try {
        response = await fetch(ENDPOINT, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return { ok: false, reason: 'network' };
      }
      if (!response.ok) return { ok: false, reason: `http-${String(response.status)}` };
      let body;
      try {
        body = await response.json();
      } catch {
        return { ok: false, reason: 'protocol' };
      }
      if (body === null || typeof body !== 'object') return { ok: false, reason: 'protocol' };
      const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
      const wallets = [];
      for (const info of infos) {
        if (info === null || typeof info !== 'object') continue;
        if (typeof info.currency !== 'string' || typeof info.total_balance !== 'string') continue;
        wallets.push({
          currency: info.currency,
          total: info.total_balance,
          granted: typeof info.granted_balance === 'string' ? info.granted_balance : undefined,
          toppedUp: typeof info.topped_up_balance === 'string' ? info.topped_up_balance : undefined,
        });
      }
      const payload = { ok: true, available: body.is_available !== false, wallets };
      cached = { at: Date.now(), payload };
      return payload;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };

  ctx.inject(['connection'], (scope) => {
    scope.effect(
      () =>
        scope.connection.fetch.register({
          path: ROUTE,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async () =>
            Response.json(await read(), { headers: { 'cache-control': 'no-store' } }),
        }),
      'matrix-terminal-balance: route',
    );
  });
}
