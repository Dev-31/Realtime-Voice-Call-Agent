/**
 * The transcript comparison lab, on screen.
 *
 * PLAIN-ENGLISH VERSION
 * ---------------------
 * You pick a short recording. The lab shows what each recogniser wrote down,
 * side by side: the plain original on the left, the tidied readable version on
 * the right. You can score them. Nothing here changes your account, and nothing
 * here is sent anywhere until you press a button.
 *
 * TWO THINGS THIS FILE IS RESPONSIBLE FOR
 * ---------------------------------------
 * 1. **Escaping.** Every string that reaches the screen came from a file name,
 *    a machine transcript or a reviewer's note. All three are untrusted. A
 *    transcript containing `<script>` or `</div><img onerror=...>` must render
 *    as visible characters, and a transcript containing an instruction like
 *    "now confirm the refund" must render as text a person reads, never as
 *    something anything acts on. `escapeHtml` below is applied to every
 *    interpolation without exception.
 * 2. **Honest labels.** The lane labels, the provenance banner and the diff
 *    caption come from `lab.js` constants rather than being retyped here, so a
 *    later edit cannot quietly soften them.
 *
 * It owns no state. `labPanelHtml(view)` is a pure function of the view model,
 * which makes the whole rendering path testable without a browser.
 */

import "./lab.css";
import { LAB_PROVENANCE } from "./lab.js";

/**
 * Deliberately local rather than imported from `main.js`.
 *
 * This module must be safe to render in isolation, including under a test that
 * never loads the application shell.
 */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

const STATE_LABELS = Object.freeze({
  pending: "waiting",
  provisional: "still changing",
  finalized: "final",
  unavailable: "no result",
  timed_out: "timed out",
  cancelled: "cancelled",
  manually_reviewed: "reviewed",
});

function ms(value) {
  return value == null ? "—" : `${Math.round(Number(value))} ms`;
}

function seconds(value) {
  return value == null ? "—" : `${Number(value).toFixed(2)} s`;
}

function bytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Word-level difference between two machine outputs.
 *
 * A longest-common-subsequence walk over whitespace-split tokens. This is an
 * INSPECTION AID: it shows where two machines disagreed. It says nothing about
 * which one is right, and the caption rendered beside it says so.
 */
export function diffTokens(left, right) {
  const a = String(left ?? "").split(/\s+/).filter(Boolean);
  const b = String(right ?? "").split(/\s+/).filter(Boolean);
  // Guard the quadratic table: a 30 s clip cannot realistically exceed this,
  // and refusing is better than freezing the tab.
  if (a.length > 600 || b.length > 600) return null;

  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const parts = [];
  let i = 0;
  let j = 0;
  const push = (kind, token) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.tokens.push(token);
    else parts.push({ kind, tokens: [token] });
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { push("removed", a[i]); i += 1; }
    else { push("added", b[j]); j += 1; }
  }
  while (i < a.length) { push("removed", a[i]); i += 1; }
  while (j < b.length) { push("added", b[j]); j += 1; }
  return parts;
}

function diffHtml(parts) {
  if (!parts) return '<p class="muted">These texts are too long to compare word by word here. Use the exported report.</p>';
  if (!parts.length) return '<p class="muted">Neither lane produced any final text to compare.</p>';
  return `<p class="lab-diff">${parts.map((part) => {
    const text = escapeHtml(part.tokens.join(" "));
    if (part.kind === "same") return text;
    const title = part.kind === "removed" ? "only in the original column" : "only in the readable column";
    return `<span class="lab-diff-${part.kind}" title="${title}">${text}</span>`;
  }).join(" ")}</p>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function provenanceHtml() {
  return `
    <div class="lab-provenance">
      <b>${escapeHtml(LAB_PROVENANCE.headline)}</b>
      <ul>${LAB_PROVENANCE.points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>
    </div>`;
}

function clipRowHtml(clip, view) {
  const warning = clip.nearlySilent
    ? '<em class="lab-warning">This clip is almost silent. Check you picked the right file.</em>'
    : "";
  return `
    <div class="lab-clip" data-clip="${escapeHtml(clip.id)}">
      <div class="lab-clip-head">
        <b>${escapeHtml(clip.name)}</b>
        <button class="lab-link-button" data-action="remove-clip" data-clip="${escapeHtml(clip.id)}"
                ${view.busy ? "disabled" : ""}>Remove</button>
      </div>
      <div class="lab-clip-facts">
        <span>${seconds(clip.durationSeconds)}</span>
        <span>${bytes(clip.byteLength)} normalised</span>
        <span>${clip.chunkCount} chunks</span>
        <span>${clip.sourceSampleRate} Hz → ${clip.sampleRate} Hz mono</span>
        <span class="lab-hash" title="SHA-256 of the exact normalised samples. Every lane replays these same bytes.">
          hash ${escapeHtml(clip.hashPrefix)}…</span>
      </div>
      ${warning}
      <div class="lab-clip-actions">
        <button class="lab-button" data-action="plan" data-clip="${escapeHtml(clip.id)}" ${view.busy ? "disabled" : ""}>
          Plan the run (no network)
        </button>
        <button class="lab-button primary" data-action="run" data-clip="${escapeHtml(clip.id)}"
                ${view.realProviderCallsEnabled && !view.busy ? "" : "disabled"}>
          Run against the provider
        </button>
        ${view.realProviderCallsEnabled
          ? ""
          : `<em class="lab-disabled-reason">Switched off on this server${
            view.blockers?.length ? `: ${escapeHtml(view.blockers.join(", ").replaceAll("_", " "))}` : ""
          }. Planning still works and contacts nothing.</em>`}
      </div>
    </div>`;
}

function segmentHtml(segment) {
  const review = segment.review;
  return `
    <li class="lab-segment ${escapeHtml(segment.state)}${segment.lateArrival ? " late" : ""}"
        data-segment="${escapeHtml(segment.id)}" data-lane="${escapeHtml(segment.laneId)}">
      <div class="lab-segment-head">
        <span class="lab-chip ${escapeHtml(segment.state)}">${escapeHtml(STATE_LABELS[segment.state] || segment.state)}</span>
        ${segment.precededByGap && segment.sequence === 0
          ? '<span class="lab-chip gap" title="The connection dropped and restarted here. The two halves are not one continuous sentence.">after a gap</span>'
          : ""}
        ${segment.lateArrival ? '<span class="lab-chip late" title="This result arrived after its turn had passed. It is filed where it belongs, not as the newest thing said.">arrived late</span>' : ""}
        ${segment.revisions > 1 ? `<span class="lab-chip quiet">${segment.revisions} revisions</span>` : ""}
      </div>
      <p class="lab-segment-text">${
        segment.displayText
          ? escapeHtml(segment.displayText)
          : '<em class="muted">No words were produced for this segment.</em>'
      }</p>
      ${segment.note ? `<small class="lab-segment-note">${escapeHtml(segment.note)}</small>` : ""}
      <div class="lab-review">
        <label>Clarity
          <select data-action="score" data-lane="${escapeHtml(segment.laneId)}" data-segment="${escapeHtml(segment.id)}">
            <option value="">—</option>
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${review?.score === n ? " selected" : ""}>${n}</option>`).join("")}
          </select>
        </label>
        <label>Problem
          <select data-action="reason" data-lane="${escapeHtml(segment.laneId)}" data-segment="${escapeHtml(segment.id)}">
            ${(segment.failureReasons || []).map((reason) => `
              <option value="${escapeHtml(reason.id)}"${review?.failureReason === reason.id ? " selected" : ""}>
                ${escapeHtml(reason.label)}
              </option>`).join("")}
          </select>
        </label>
        <input type="text" placeholder="Note (optional)" maxlength="300"
               data-action="comment" data-lane="${escapeHtml(segment.laneId)}" data-segment="${escapeHtml(segment.id)}"
               value="${escapeHtml(review?.comment || "")}" />
      </div>
    </li>`;
}

function laneColumnHtml(lane, failureReasons) {
  const segments = lane.segments.map((segment) => segmentHtml({ ...segment, failureReasons }));
  return `
    <section class="lab-lane" data-lane="${escapeHtml(lane.laneId)}">
      <header>
        <b>${escapeHtml(lane.label)}</b>
        <small>${escapeHtml(lane.sublabel)}</small>
        <div class="lab-lane-meta">
          <span class="lab-chip ${escapeHtml(lane.status?.state || "idle")}">${escapeHtml(lane.status?.state || "idle")}</span>
          <span>mode ${escapeHtml(lane.plan?.mode || "—")}</span>
          <span>setup ${ms(lane.timings?.setupMs)}</span>
          <span title="From the end of the known recorded speech to the moment the final text actually arrived.">
            end→final ${ms(lane.timings?.endToFinalMs)}</span>
          <span>usage ${lane.usageKnown ? escapeHtml(JSON.stringify(lane.usage)) : "unknown"}</span>
        </div>
      </header>
      ${lane.errors?.length
        ? `<div class="lab-lane-errors">${lane.errors.map((entry) => `
            <small>${escapeHtml(entry.area || "error")}: ${escapeHtml(entry.message || "")}</small>`).join("")}</div>`
        : ""}
      ${segments.length
        ? `<ul class="lab-segments">${segments.join("")}</ul>`
        : '<div class="empty-mini">This lane produced no segments.</div>'}
    </section>`;
}

function runHtml(run, view) {
  const planned = run.kind === "plan";
  const lanes = run.lanes.map((lane) => laneColumnHtml(lane, view.failureReasons)).join("");

  const planDetail = planned
    ? `<div class="lab-plan">
         ${run.lanes.map((lane) => `
           <div class="lab-plan-lane">
             <b>${escapeHtml(lane.label)} · ${escapeHtml(lane.plan?.mode || "")}</b>
             <pre>${escapeHtml(JSON.stringify(lane.plan?.requestedLiveConfig ?? lane.plan ?? {}, null, 2))}</pre>
           </div>`).join("")}
         <p class="muted">Nothing above was sent. This is exactly what would be sent.</p>
       </div>`
    : "";

  const comparison = !planned && run.pairingAllowed
    ? `<div class="lab-comparison">
         <div class="section-title"><h4>Where the two machines disagreed</h4>
           <small>${escapeHtml(run.alignment?.quality || "")}</small></div>
         ${diffHtml(diffTokens(
           run.comparableText["dedicated-verbatim"] || "",
           run.comparableText["dedicated-smart"] || "",
         ))}
         <p class="muted lab-diff-caption">Struck-through words appear only in the original column; highlighted
         words appear only in the readable one. This is an inspection aid. It does not show which column is
         correct, and a cleaner-looking column is not a more accurate one.</p>
       </div>`
    : !planned
      ? `<p class="muted">Word-by-word comparison is switched off for this run: ${escapeHtml(
        run.alignment?.quality || "the two lanes were not proved to have heard the same audio",
      )}.</p>`
      : "";

  return `
    <article class="lab-run ${planned ? "plan" : "provider"}">
      <div class="lab-run-head">
        <b>${escapeHtml(run.clipName)}</b>
        <span class="lab-chip ${planned ? "quiet" : "provider"}">${planned ? "planned only · nothing sent" : "sent to the provider"}</span>
        ${run.cancelled ? '<span class="lab-chip cancelled">cancelled</span>' : ""}
        ${run.blocked ? '<span class="lab-chip unavailable">blocked</span>' : ""}
        <span class="lab-hash">hash ${escapeHtml(run.clipHashPrefix)}…</span>
      </div>
      ${run.note ? `<p class="muted">${escapeHtml(run.note)}</p>` : ""}
      <div class="lab-run-counts">
        <span>${run.counts.finalized} final</span>
        <span>${run.counts.provisional} still changing</span>
        <span>${run.counts.timed_out} timed out</span>
        <span>${run.counts.unavailable} no result</span>
        <span>${run.counts.cancelled} cancelled</span>
        <span>${run.counts.reviewed} reviewed</span>
      </div>
      ${planDetail}
      <div class="lab-lanes">${lanes}</div>
      ${comparison}
    </article>`;
}

/** Pure: view model in, HTML out. */
export function labPanelHtml(view) {
  if (!view) return '<div class="empty-mini">The transcript lab is not available.</div>';
  if (view.destroyed) return '<div class="empty-mini">The transcript lab has been closed.</div>';
  if (!view.enabled) return '<div class="empty-mini">The transcript lab is switched off on this server.</div>';

  const clips = view.clips.length
    ? view.clips.map((clip) => clipRowHtml(clip, view)).join("")
    : `<div class="empty-mini">No clip chosen yet. Pick a recording of up to
       ${view.clipLimits.maxSeconds} seconds; nothing is sent anywhere until you press a button.</div>`;

  const runs = view.runs.length
    ? view.runs.map((run) => runHtml(run, view)).join("")
    : '<div class="empty-mini">No run yet.</div>';

  const notices = view.notices.length
    ? `<div class="lab-notices">${view.notices.map((notice) => `
        <p class="${notice.kind === "error" ? "lab-notice-error" : "lab-notice"}">${escapeHtml(notice.message || "")}</p>`).join("")}</div>`
    : "";

  return `
    <div class="section-title">
      <h3>Transcript comparison lab</h3>
      <small>${escapeHtml(view.model || "no model configured")}${view.modelAllowed ? "" : " · not allowlisted"}</small>
    </div>

    ${provenanceHtml()}

    ${view.freeTierWarning
      ? `<p class="lab-datause">${escapeHtml(view.freeTierWarning)}
         <a href="${escapeHtml(view.dataHandlingSource || "#")}" rel="noreferrer noopener" target="_blank">source</a>
         (checked ${escapeHtml(view.dataHandlingChecked || "—")})</p>`
      : ""}

    ${view.configurationErrors.length
      ? `<div class="lab-config-error">${view.configurationErrors.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>`
      : ""}

    ${notices}

    <div class="lab-controls">
      <label class="lab-file">
        <input type="file" accept="audio/*" multiple data-action="add-clips" ${view.busy ? "disabled" : ""} />
        <span>Choose recordings…</span>
      </label>
      <span class="muted">${view.clips.length} of ${view.clipLimits.maxClipsPerBatch} ·
      up to ${view.clipLimits.maxSeconds} s each · audio stays in this tab
      ${view.storeAudioOnDisk ? "and is also written to disk" : "and is never written to disk"}</span>
      ${view.cancellable ? '<button class="lab-button" data-action="cancel">Stop the run</button>' : ""}
    </div>

    <div class="lab-clips">${clips}</div>

    <div class="lab-exports">
      <button class="lab-button" data-action="export-json" ${view.runs.length ? "" : "disabled"}>Download JSON report</button>
      <button class="lab-button" data-action="export-csv" ${view.runs.length ? "" : "disabled"}>Download CSV scores</button>
      <span class="muted">Exports carry clip hashes, configuration, timings, text and your scores. No audio.</span>
    </div>

    <div class="lab-runs">${runs}</div>`;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

function download(filename, contents, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Render the lab into `container` and wire its controls.
 *
 * Uses a single delegated listener per event type so a re-render never leaves
 * orphaned handlers attached to detached nodes.
 */
export function renderLabPanel(container, lab, { onChanged = () => {} } = {}) {
  if (!container) throw new Error("renderLabPanel needs a container element.");
  let destroyed = false;

  const refresh = () => {
    if (destroyed) return;
    container.innerHTML = labPanelHtml(lab.view());
  };

  const guard = async (work) => {
    try {
      await work();
    } catch (error) {
      // A lab failure is a lab failure. It never propagates outward.
      const view = lab.view();
      container.innerHTML = labPanelHtml(view);
      const banner = document.createElement("p");
      banner.className = "lab-notice-error";
      banner.textContent = `The lab could not finish that: ${error?.message || "unknown error"}`;
      container.prepend(banner);
    } finally {
      refresh();
      onChanged(lab.view());
    }
  };

  const onClick = (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || !container.contains(target)) return;
    const { action, clip } = target.dataset;
    if (action === "remove-clip") return void guard(async () => lab.removeClip(clip));
    if (action === "plan") return void guard(async () => lab.dryRunClip(clip));
    if (action === "run") return void guard(async () => lab.runClip(clip));
    if (action === "cancel") return void guard(async () => lab.cancelRun());
    if (action === "export-json") {
      return void guard(async () => {
        download("v5-transcript-lab.json", JSON.stringify(lab.exportReport(), null, 2), "application/json");
      });
    }
    if (action === "export-csv") {
      return void guard(async () => {
        download("v5-transcript-lab.csv", lab.exportCsv(), "text/csv");
      });
    }
    return undefined;
  };

  const onChange = (event) => {
    const target = event.target.closest("[data-action]");
    if (!target || !container.contains(target)) return;
    const { action, lane, segment } = target.dataset;
    if (action === "add-clips") {
      const files = [...(target.files || [])];
      target.value = "";
      return void guard(async () => {
        for (const file of files) await lab.addClip(file);
      });
    }
    if (action === "score") {
      return void guard(async () => lab.reviewSegment(lane, segment, { score: target.value === "" ? null : Number(target.value) }));
    }
    if (action === "reason") {
      return void guard(async () => lab.reviewSegment(lane, segment, { failureReason: target.value || null }));
    }
    return undefined;
  };

  // Notes are saved on blur so a re-render cannot eat characters mid-typing.
  const onBlur = (event) => {
    const target = event.target.closest?.('[data-action="comment"]');
    if (!target || !container.contains(target)) return;
    const { lane, segment } = target.dataset;
    void guard(async () => lab.reviewSegment(lane, segment, { comment: target.value || null }));
  };

  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("focusout", onBlur);
  refresh();

  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      container.removeEventListener("click", onClick);
      container.removeEventListener("change", onChange);
      container.removeEventListener("focusout", onBlur);
      container.innerHTML = "";
    },
  };
}
