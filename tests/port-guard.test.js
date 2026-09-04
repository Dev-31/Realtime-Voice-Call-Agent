/**
 * V5 must not start on a V1-V4 port.
 *
 * This is a regression test for a real failure, not a hypothetical. V5's first
 * real start used a `.env` copied from V4 to bring the API key across; that file
 * carries `PORT=4175`. V5's API bound V4's port, V5's dev server kept proxying
 * `/api` to 4176 where nothing was listening, and the browser app was entirely
 * broken with no message saying why -- while also blocking V4, the fallback
 * demo, from starting at all.
 *
 * A silent misconfiguration that breaks everything is worse than a refusal.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESERVED_PORTS,
  V5_API_PORT,
  V5_DEV_PORT,
  checkApiPort,
  proxyMismatchWarning,
} from "../server/port-guard.js";

const PROJECT_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

test("every port belonging to a frozen project is refused, and says whose it is", () => {
  for (const [port, owner] of Object.entries(RESERVED_PORTS)) {
    const result = checkApiPort(port);
    assert.equal(result.ok, false, `port ${port} must be refused`);
    assert.equal(result.owner, owner);
    assert.match(result.message, /Refusing to start/);
    assert.ok(result.message.includes(owner), "the message must name the owning project");
  }
});

test("V4's port is refused with the .env explanation that actually caused it", () => {
  const result = checkApiPort(4175);
  assert.equal(result.ok, false);
  assert.equal(result.owner, "V4 API");
  // The message has to name the real cause, or the next person loses an hour.
  assert.match(result.message, /\.env/);
  assert.match(result.message, /PORT=4175/);
  assert.match(result.message, /PORT=4176/);
});

test("V5's own port is allowed", () => {
  const result = checkApiPort(V5_API_PORT);
  assert.deepEqual(result, { ok: true, port: V5_API_PORT });
});

test("an unset port falls through to V5's default, which is allowed", () => {
  assert.equal(checkApiPort(process.env.NOT_SET_ANYWHERE || V5_API_PORT).ok, true);
});

test("a nonsense port is refused rather than coerced", () => {
  for (const bad of ["abc", "", null, undefined, 0, -1, 99999, 1.5, NaN]) {
    const result = checkApiPort(bad);
    assert.equal(result.ok, false, `${String(bad)} must be refused`);
    assert.match(result.message, /not a usable port number/);
  }
});

test("a port that disagrees with the dev-server proxy produces a warning", () => {
  assert.equal(proxyMismatchWarning(V5_API_PORT), null, "the matching case must be silent");

  const warning = proxyMismatchWarning(4175);
  assert.ok(warning, "a mismatch must warn");
  assert.match(warning, /4175/);
  assert.match(warning, new RegExp(String(V5_API_PORT)));
  assert.match(warning, /will not be able to reach the API/);
});

test("the reserved list actually matches V4's committed configuration", () => {
  // If V4 is ever re-read and found on a different port, this test fails and the
  // reserved list has to be corrected rather than quietly drifting.
  const v4Vite = readFileSync(join(PROJECT_ROOT, "..", "Prodapt IPL project V4", "vite.config.js"), "utf8");
  assert.match(v4Vite, /port:\s*5174/, "V4's dev server is expected on 5174");
  assert.match(v4Vite, /127\.0\.0\.1:4175/, "V4's API is expected on 4175");
  assert.equal(RESERVED_PORTS[5174], "V4 dev server");
  assert.equal(RESERVED_PORTS[4175], "V4 API");
});

test("V5's own configuration is internally consistent", () => {
  const vite = readFileSync(join(PROJECT_ROOT, "vite.config.js"), "utf8");
  assert.match(vite, new RegExp(`port:\\s*${V5_DEV_PORT}`), "V5's dev server must be on its own port");
  assert.match(
    vite,
    new RegExp(`127\\.0\\.0\\.1:${V5_API_PORT}`),
    "V5's proxy target must be V5's API port",
  );
  assert.equal(RESERVED_PORTS[V5_API_PORT], undefined, "V5's API port must not be a reserved one");
  assert.equal(RESERVED_PORTS[V5_DEV_PORT], undefined, "V5's dev port must not be a reserved one");
});

test("the shipped .env.example does not contain a frozen project's port", () => {
  const example = readFileSync(join(PROJECT_ROOT, ".env.example"), "utf8");
  for (const line of example.split("\n")) {
    const match = /^\s*PORT\s*=\s*(\d+)/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    assert.equal(
      RESERVED_PORTS[port],
      undefined,
      `.env.example ships PORT=${port}, which belongs to ${RESERVED_PORTS[port]}`,
    );
    assert.equal(port, V5_API_PORT);
  }
});
