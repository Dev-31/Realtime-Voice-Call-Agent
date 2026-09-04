/**
 * V5 must not run on a V1-V4 port.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first time V5 was started for real, its `.env` had been copied from V4 to
 * bring the API key across. That file carries `PORT=4175` -- V4's port. The
 * result was silent and confusing rather than a clean error:
 *
 *   - V5's API bound 4175 instead of 4176.
 *   - V5's Vite dev server still proxied `/api` to 4176, where nothing was
 *     listening, so every request from the browser was refused. The app looked
 *     completely broken with no message explaining why.
 *   - V5 was now squatting on V4's port, so V4 -- the fallback demo -- could no
 *     longer start either.
 *
 * A configuration file that can quietly point V5 at V4's port is a footgun, and
 * "V1-V4 stay untouched" is a hard project rule. So the port is checked before
 * anything binds, and a collision is a refusal with an explanation, not a
 * mystery.
 */

/** Ports owned by the frozen projects. Do not reuse any of them. */
export const RESERVED_PORTS = Object.freeze({
  4174: "V1/V2/V3 API",
  4175: "V4 API",
  5173: "V1/V2/V3 dev server",
  5174: "V4 dev server",
});

export const V5_API_PORT = 4176;
export const V5_DEV_PORT = 5175;

/**
 * Validate a port for V5's API.
 *
 * @returns {{ok: true, port: number} | {ok: false, port: number, owner: string|null, message: string}}
 */
export function checkApiPort(requested) {
  const port = Number(requested);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      port,
      owner: null,
      message:
        `PORT=${requested} is not a usable port number.\n` +
        `  Set PORT=${V5_API_PORT} in this project's .env, or remove the line to use the default.`,
    };
  }

  const owner = RESERVED_PORTS[port];
  if (owner) {
    return {
      ok: false,
      port,
      owner,
      message:
        `Refusing to start: port ${port} belongs to ${owner}.\n` +
        "\n" +
        "  V1-V4 are frozen. Taking one of their ports would stop the fallback demo\n" +
        "  from starting, and V5's own dev server proxies /api to " + V5_API_PORT + ", so nothing\n" +
        "  in the browser would reach this API anyway.\n" +
        "\n" +
        "  This usually means .env was copied from V4 to bring the API key across.\n" +
        `  That file contains PORT=4175. Change it to PORT=${V5_API_PORT} and start again.\n` +
        "\n" +
        `    e:/Voice Agent 1/Prodapt IPL project V5/.env  ->  PORT=${V5_API_PORT}`,
    };
  }

  return { ok: true, port };
}

/**
 * Warn when V5's API port and its dev-server proxy target disagree.
 *
 * A mismatch is not fatal for the API process itself -- it will serve requests
 * happily -- but it makes the browser app completely non-functional, which is
 * exactly the failure this module was written for. Better to say so at startup.
 */
export function proxyMismatchWarning(apiPort, proxyTarget = V5_API_PORT) {
  if (Number(apiPort) === Number(proxyTarget)) return null;
  return (
    `Warning: this API is on ${apiPort}, but vite.config.js proxies /api to ${proxyTarget}.\n` +
    "  The browser app will not be able to reach the API until those agree."
  );
}
