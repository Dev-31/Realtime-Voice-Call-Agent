#!/usr/bin/env node
/**
 * Gate 5 aggregator.
 *
 * Reads the recorded calls straight out of the database and prints the frozen
 * final-run verdict. It never invents a number: where a measurement is missing
 * it says so instead of assuming a pass.
 *
 *   npm run gate:report              last 20 calls
 *   npm run gate:report -- --calls 5 last 5 calls
 *   npm run gate:report -- --json    machine-readable
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertV5DatabasePath } from "../server/db-path-guard.js";
import { openDatabase } from "../server/db.js";
import { createFlightRecorder } from "../server/flight-recorder/index.js";

const projectRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

const TARGETS = Object.freeze({
  responseLatencyP95Ms: 2500,
  audibleStopP95Ms: 500,
  preservationRate: 0.9,
});

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function verdict(passed) {
  return passed === null ? "UNMEASURED" : passed ? "PASS" : "FAIL";
}

const wanted = Number(argument("calls", 20));
const asJson = process.argv.includes("--json");
const databasePath = assertV5DatabasePath(
  argument("db", join(projectRoot, "data", "actionguard-v5.db")),
);

const db = openDatabase(databasePath);
const recorder = createFlightRecorder(db, { enabled: true });
const reports = recorder.latestReports(wanted);

if (!reports.length) {
  console.error(`No recorded calls found in ${databasePath}. Run a physical call first.`);
  process.exit(1);
}

const responseLatencies = [];
const audibleStops = [];
let preservedOutcomes = 0;
let measuredOutcomes = 0;
let reintroductions = 0;
let duplicateExecutions = 0;
let mismatchedCalls = 0;
let unmeasuredStopCalls = 0;
let moneyIssued = 0;
let quarantined = 0;
let resumeInjections = 0;

for (const report of reports) {
  for (const item of report.response_timeline) if (item.latency_ms != null) responseLatencies.push(item.latency_ms);
  for (const item of report.interruption_timeline) {
    if (item.audible_stop_ms == null) unmeasuredStopCalls += 1;
    else audibleStops.push(item.audible_stop_ms);
  }
  measuredOutcomes += report.metrics.interruption_outcomes_measured;
  preservedOutcomes += report.metrics.preserved_or_resumed;
  reintroductions += report.metrics.suspected_reintroductions;
  duplicateExecutions += report.database_match.duplicate_executions;
  moneyIssued += report.database_match.money_issued;
  quarantined += report.metrics.unheard_segments_quarantined;
  resumeInjections += report.metrics.resume_context_injections;
  if (!report.database_match.matches) mismatchedCalls += 1;
}

const responseP95 = percentile(responseLatencies, 0.95);
const stopP95 = percentile(audibleStops, 0.95);
const preservationRate = measuredOutcomes ? preservedOutcomes / measuredOutcomes : null;

const gates = [
  {
    id: "response_latency_p95",
    label: `Response latency p95 <= ${TARGETS.responseLatencyP95Ms} ms`,
    measured: responseP95 == null ? null : `${Math.round(responseP95)} ms`,
    passed: responseP95 == null ? null : responseP95 <= TARGETS.responseLatencyP95Ms,
    samples: responseLatencies.length,
  },
  {
    id: "audible_stop_p95",
    label: `Audible stop p95 <= ${TARGETS.audibleStopP95Ms} ms`,
    measured: stopP95 == null ? null : `${Math.round(stopP95)} ms`,
    passed: stopP95 == null ? null : stopP95 <= TARGETS.audibleStopP95Ms,
    samples: audibleStops.length,
    note: unmeasuredStopCalls ? `${unmeasuredStopCalls} interruption(s) had no speech-start estimate` : null,
  },
  {
    id: "acknowledgement_preservation",
    label: "Interrupted explanation preserved or resumed >= 9 in 10",
    measured: preservationRate == null ? null : `${preservedOutcomes}/${measuredOutcomes}`,
    passed: preservationRate == null ? null : preservationRate >= TARGETS.preservationRate,
    samples: measuredOutcomes,
    note: "Estimated from text overlap. Confirm by listening before claiming this gate.",
  },
  {
    id: "no_reintroductions",
    label: "Zero repeated introductions after an interruption",
    measured: String(reintroductions),
    passed: reintroductions === 0,
    samples: measuredOutcomes,
    note: "Estimated from overlap with the opening line.",
  },
  {
    id: "exactly_once",
    label: "Zero wrong or duplicate business actions",
    measured: String(duplicateExecutions),
    passed: duplicateExecutions === 0,
    samples: reports.length,
  },
  {
    id: "no_money",
    label: "Zero money issued by the Twin",
    measured: String(moneyIssued),
    passed: moneyIssued === 0,
    samples: reports.length,
  },
  {
    id: "report_database_match",
    label: "Report and database match after every call",
    measured: `${reports.length - mismatchedCalls}/${reports.length} calls`,
    passed: mismatchedCalls === 0,
    samples: reports.length,
  },
];

const overall = gates.every((gate) => gate.passed === true);
const summary = {
  database: databasePath,
  callsAnalysed: reports.length,
  callsRequestedForGate5: 20,
  unheardSegmentsQuarantined: quarantined,
  heardStateNotesInjected: resumeInjections,
  gates,
  overall: overall ? "PASS" : gates.some((gate) => gate.passed === false) ? "FAIL" : "INCOMPLETE",
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(overall ? 0 : 1);
}

const line = "-".repeat(84);
console.log(`\nHCR ActionGuard - Gate 5 report`);
console.log(line);
console.log(`Database        ${databasePath}`);
console.log(`Calls analysed  ${reports.length} (Gate 5 asks for 20: 5 normal, 5 backchannel, 5 correction, 5 adverse)`);
console.log(`Unheard words quarantined: ${quarantined}   Heard-state notes injected: ${resumeInjections}`);
console.log(line);
for (const gate of gates) {
  const measured = gate.measured ?? "not measured";
  console.log(`${verdict(gate.passed).padEnd(11)} ${gate.label}`);
  console.log(`            measured ${measured}   (${gate.samples} sample${gate.samples === 1 ? "" : "s"})`);
  if (gate.note) console.log(`            note: ${gate.note}`);
}
console.log(line);
console.log(`OVERALL: ${summary.overall}`);
if (reports.length < 20) {
  console.log(`Only ${reports.length} of the 20 required calls are recorded, so this is not yet a Gate 5 verdict.`);
}
console.log("");
process.exit(overall && reports.length >= 20 ? 0 : 1);
