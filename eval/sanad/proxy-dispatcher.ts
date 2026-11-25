/**
 * Testcontainers replaces Node's global fetch dispatcher when it is imported, which
 * drops the HTTPS proxy Node sets up from the environment (NODE_USE_ENV_PROXY) — real
 * provider calls then try direct DNS and fail. Import this module before anything that
 * loads Testcontainers; call restoreProxyDispatcher() once the containers have started.
 */
const key = Symbol.for('undici.globalDispatcher.1');
const globals = globalThis as Record<symbol, unknown>;
const original = globals[key];

export function restoreProxyDispatcher(): void {
  if (original !== undefined) globals[key] = original;
}
