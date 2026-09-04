import assert from "node:assert/strict";
import test from "node:test";
import { HeardStateTracker, splitHeardText } from "../src/hcr/heard-state.js";

function tracker(transitions = []) {
  let clock = 0;
  let counter = 0;
  const instance = new HeardStateTracker({
    idFactory: () => `epoch-${++counter}`,
    now: () => (clock += 10),
    onTransition: (event) => transitions.push(event),
  });
  return instance;
}

test("splitHeardText never cuts a word in half", () => {
  const draft = "I can send the eighteen rupee charge to Billing for review";
  const { heardText, unheardText } = splitHeardText(draft, 0.5);
  assert.ok(heardText.length > 0);
  assert.ok(unheardText.length > 0);
  assert.equal(`${heardText} ${unheardText}`, draft);
  assert.ok(!heardText.endsWith(" "));
});

test("splitHeardText handles the two extremes", () => {
  assert.deepEqual(splitHeardText("all of it", 1), { heardText: "all of it", unheardText: "" });
  assert.deepEqual(splitHeardText("none of it", 0), { heardText: "", unheardText: "none of it" });
  assert.deepEqual(splitHeardText("", 0.5), { heardText: "", unheardText: "" });
});

test("a fully played response is completed and claims everything as heard", () => {
  const hcr = tracker();
  hcr.noteDraftText("Your Premium plan renews on the thirty first.");
  hcr.noteAudioScheduled(400);
  hcr.noteAudioAudible(400);
  hcr.noteTurnComplete();
  const epoch = hcr.noteAudioDrained();

  assert.equal(epoch.state, "completed");
  assert.equal(epoch.heardText, "Your Premium plan renews on the thirty first.");
  assert.equal(epoch.unheardText, "");
  assert.equal(hcr.resumeNote(), null);
});

test("an interruption splits heard from unheard and quarantines the remainder", () => {
  const hcr = tracker();
  hcr.noteDraftText("I can send the eighteen rupee charge to Billing and they usually reply within two working days.");
  hcr.noteAudioScheduled(1000);
  hcr.noteAudioAudible(300);
  const epoch = hcr.interrupt({ audibleMsOverride: 300 });

  assert.equal(epoch.state, "interrupted");
  assert.ok(epoch.heardText.length > 0, "some words reached the caller");
  assert.ok(epoch.unheardText.includes("working days"), "the tail was never played");
  assert.ok(!epoch.heardText.includes("working days"));
  assert.equal(hcr.pendingRemainder.epochId, epoch.id);
});

test("the resume note states what was not delivered and never claims it was", () => {
  const hcr = tracker();
  hcr.noteDraftText("First point. Second point. Third point that was cut off.");
  hcr.noteAudioScheduled(900);
  hcr.noteAudioAudible(300);
  hcr.interrupt({ audibleMsOverride: 300 });

  const note = hcr.resumeNote();
  assert.match(note, /did NOT hear/);
  assert.match(note, /never delivered/);
  assert.match(note, /cut off/);
});

test("unheard content never leaks into the next epoch's heard record", () => {
  const hcr = tracker();
  hcr.noteDraftText("Alpha bravo charlie delta echo foxtrot golf hotel.");
  hcr.noteAudioScheduled(800);
  hcr.noteAudioAudible(200);
  const interrupted = hcr.interrupt({ audibleMsOverride: 200 });
  const unheard = interrupted.unheardText;

  const next = hcr.ensureEpoch();
  assert.notEqual(next.id, interrupted.id);
  assert.equal(next.state, "planned");
  assert.equal(next.heardText, "");
  assert.equal(next.resumeOf, interrupted.id, "the new response is linked to what was cut off");
  assert.ok(unheard.length > 0);
});

test("markResumed records that the remainder was picked up again", () => {
  const transitions = [];
  const hcr = tracker(transitions);
  hcr.noteDraftText("One two three four five six seven eight.");
  hcr.noteAudioScheduled(800);
  hcr.noteAudioAudible(200);
  hcr.interrupt({ audibleMsOverride: 200 });

  const next = hcr.ensureEpoch();
  hcr.markResumed(next.id);
  assert.equal(next.state, "resumed");
  assert.equal(hcr.pendingRemainder.consumedBy, next.id);
  assert.ok(transitions.some((event) => event.state === "resumed"));
});

test("discardRemainder drops the remainder when the caller moved on", () => {
  const hcr = tracker();
  hcr.noteDraftText("Something long enough to split in half here.");
  hcr.noteAudioScheduled(600);
  hcr.noteAudioAudible(200);
  hcr.interrupt({ audibleMsOverride: 200 });

  assert.ok(hcr.resumeNote());
  const dropped = hcr.discardRemainder();
  assert.ok(dropped.unheardText.length > 0);
  assert.equal(hcr.resumeNote(), null);
});

test("an interruption before any audio played reports zero heard", () => {
  const hcr = tracker();
  hcr.noteDraftText("Never reached the speaker at all.");
  hcr.noteAudioScheduled(500);
  const epoch = hcr.interrupt({ audibleMsOverride: 0 });

  assert.equal(epoch.state, "interrupted");
  assert.equal(epoch.audibleChunks, 0);
  assert.equal(epoch.heardText, "");
  assert.equal(epoch.unheardText, "Never reached the speaker at all.");
});

test("draining without turnComplete does not falsely complete a response", () => {
  const hcr = tracker();
  hcr.noteDraftText("Still generating");
  hcr.noteAudioScheduled(200);
  hcr.noteAudioAudible(200);
  assert.equal(hcr.noteAudioDrained(), null);
  assert.equal(hcr.active.state, "speaking");
});

test("snapshot exposes exact counts and labels the word split as an estimate", () => {
  const hcr = tracker();
  hcr.noteDraftText("Some drafted words here for the caller.");
  hcr.noteAudioScheduled(400);
  hcr.noteAudioScheduled(400);
  hcr.noteAudioAudible(400);
  const epoch = hcr.interrupt({ audibleMsOverride: 400 });
  const snapshot = epoch.snapshot();

  assert.equal(snapshot.scheduledChunks, 2);
  assert.equal(snapshot.audibleChunks, 1);
  assert.equal(snapshot.precision.chunkCounts, "exact");
  assert.equal(snapshot.precision.wordSplit, "estimated-from-audio-progress");
  assert.equal(snapshot.heardFraction, 0.5);
});
