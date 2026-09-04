import "./styles.css";
import "./actionguard.css";
import "./v5.css";
import "./caller.css";
import { createFlightRecorderClient } from "./recorder/client.js";

let voice = null;
/**
 * Memoise the PROMISE, not the resolved module.
 *
 * `voice ||= await import(...)` desugars to `voice || (voice = await import(...))`,
 * so the assignment happens only after the await resolves. Two callers arriving
 * during that first fetch both see `voice === null` and both start an import.
 * Holding the promise instead makes the second caller wait on the first.
 */
let voiceModulePromise = null;
async function voiceModule() {
  voiceModulePromise ||= import("./voice/gemini-live.js").then((module) => {
    voice = module;
    return module;
  });
  return voiceModulePromise;
}

/**
 * V5 browser storage namespace.
 *
 * V4 used `actionguard_token` / `actionguard_role`. V5 uses its own keys so the
 * two versions can be open in the same browser without sharing a login, and so
 * signing out of V5 never clears another version's session.
 */
export const V5_STORAGE_KEYS = Object.freeze(["v5_actionguard_token", "v5_actionguard_role"]);

function clearV5Storage() {
  for (const key of V5_STORAGE_KEYS) sessionStorage.removeItem(key);
}

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

const state = {
  token: sessionStorage.getItem("v5_actionguard_token"),
  role: sessionStorage.getItem("v5_actionguard_role"),
  roleChoice: "customer",
  me: null,
  connected: false,
  status: "Not connected",
  activity: [],
  recorder: null,
  scenario: "billing-review",
  hcrTimer: null,

  // --- V5 ---------------------------------------------------------------
  /** The effective feature set from GET /api/v5/features. Server-authoritative. */
  features: null,
  /** Delivery style for the NEXT call. Locked while a call is connected. */
  voiceStyle: "baseline",
  /** How output audio is played. See src/voice/playback-mode.js. */
  playbackMode: "continuous",
  /** Prebuilt voice for the NEXT call. */
  voice: "Kore",
  /** Conversation engine for the NEXT call: standard | expressive. */
  engineMode: "standard",
  /** Provider-native activity-start trial; no identity or denoising claim. */
  noiseMode: "baseline",
  /** Latest caller/agent caption text, for the live strip. */
  caption: "",
  /** The transcript lab is opened on demand: nothing is loaded or sent until then. */
  labOpen: false,
  lab: null,
  labPanel: null,
};

/**
 * The transcript lab is a separate chunk, imported only when the caller opens
 * it. That keeps it off the critical path of a normal call and makes
 * "feature off means no extra work" literally true rather than a claim.
 */
let labModule = null;
async function transcriptLabModule() {
  labModule ||= await import("./transcription/lab.js");
  return labModule;
}
let labPanelModule = null;
async function transcriptPanelModule() {
  labPanelModule ||= await import("./transcription/panel.js");
  return labPanelModule;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escape(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function money(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
    .format(Number(value || 0));
}

function dateTime(value) {
  return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

function ms(value) {
  return value == null ? "—" : `${Math.round(Number(value))} ms`;
}

function seconds(value) {
  return `${(Number(value || 0) / 1000).toFixed(2)}s`;
}

function percent(value) {
  return value == null ? "—" : `${Math.round(Number(value) * 100)}%`;
}

function showToast(message, kind = "success") {
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  setTimeout(() => { toast.className = "toast"; }, 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The request failed.");
  return body;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function loginView() {
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-story">
        <div class="brand"><span class="brand-mark">A</span><span>HCR ActionGuard</span></div>
        <div class="story-copy">
          <span class="eyebrow">PRODAPT IPL · TEAM TWINFORGE</span>
          <h1>Interrupt it.<br><span>It still gets the action right.</span></h1>
          <p>Most voice demos prove an AI can talk. This one proves it can be cut off mid-sentence during real customer-service work without losing the correction or doing the business action twice.</p>
          <div class="story-flow">
            <div><b>01</b><span>Stop fast</span></div><i></i>
            <div><b>02</b><span>Keep what was heard</span></div><i></i>
            <div><b>03</b><span>Act exactly once</span></div>
          </div>
        </div>
        <div class="security-note"><span>◉</span> Every interruption, correction and action is replayable in the Call Flight Recorder.</div>
      </section>
      <section class="login-panel">
        <div class="login-card">
          <span class="eyebrow">WELCOME</span>
          <h2>Choose your workspace</h2>
          <p class="muted">Your role decides exactly what you can see and do.</p>
          <div class="role-switch" role="tablist">
            <button class="role-button active" data-role="customer"><span>◎</span><b>Caller</b><small>Billing support call</small></button>
            <button class="role-button" data-role="employee"><span>◇</span><b>Billing team</b><small>Flight recorder</small></button>
          </div>
          <form id="loginForm" class="login-form">
            <div id="customerFields">
              <label>Account number<input name="accountNumber" value="CUST-1002" autocomplete="username" required /></label>
              <label>4-digit demo PIN<input name="pin" type="password" inputmode="numeric" value="1002" autocomplete="current-password" required /></label>
            </div>
            <div id="employeeFields" hidden>
              <label>Employee email<input name="email" type="email" value="employee@prodapt.demo" autocomplete="username" /></label>
              <label>Password<input name="password" type="password" value="TwinForge#2026" autocomplete="current-password" /></label>
            </div>
            <button class="primary-button" type="submit">Enter workspace <span>→</span></button>
          </form>
          <p class="demo-hint">Akash (<b>CUST-1002 / 1002</b>) has the ₹18 disputed charge used in the judged billing-review call.</p>
        </div>
      </section>
    </main>`;

  for (const button of document.querySelectorAll(".role-button")) {
    button.addEventListener("click", () => {
      state.roleChoice = button.dataset.role;
      for (const item of document.querySelectorAll(".role-button")) item.classList.toggle("active", item === button);
      document.querySelector("#customerFields").hidden = state.roleChoice !== "customer";
      document.querySelector("#employeeFields").hidden = state.roleChoice !== "employee";
    });
  }
  document.querySelector("#loginForm").addEventListener("submit", login);
}

async function login(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = state.roleChoice === "customer"
    ? { role: "customer", accountNumber: form.get("accountNumber"), pin: form.get("pin") }
    : { role: "employee", email: form.get("email"), password: form.get("password") };
  try {
    const session = await api("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
    state.token = session.token;
    state.role = session.role;
    sessionStorage.setItem("v5_actionguard_token", state.token);
    sessionStorage.setItem("v5_actionguard_role", state.role);
    await loadWorkspace();
  } catch (error) { showToast(error.message, "error"); }
}

async function logoutUser() {
  if (voice) voice.disconnectVoiceAgent();
  stopHcrPolling();
  // The lab holds timers, object URLs and possibly a provider socket. Tear it
  // down explicitly rather than relying on the page being replaced.
  try { state.labPanel?.destroy?.(); } catch { /* already gone */ }
  try { state.lab?.destroy?.(); } catch { /* already gone */ }
  state.labPanel = null;
  state.lab = null;
  state.labOpen = false;
  state.features = null;
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  state.token = null;
  state.role = null;
  state.me = null;
  clearV5Storage();
  loginView();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function shell(title, subtitle, body, chip) {
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">A</span><span>ActionGuard</span></div>
        <div class="sidebar-footer">
          <div class="scope-pill"><i></i>Direct Gemini Live voice core.<br />Browser mic and speaker stand in for the phone leg.</div>
          <button class="logout-button" id="logoutButton">Sign out</button>
        </div>
      </aside>
      <main class="workspace">
        <header class="topbar">
          <div><span class="eyebrow">HCR ACTIONGUARD</span><h2>${escape(title)}</h2><p>${escape(subtitle)}</p></div>
          ${chip}
        </header>
        ${body}
      </main>
    </div>`;
  document.querySelector("#logoutButton").addEventListener("click", logoutUser);
}

// ---------------------------------------------------------------------------
// Caller workspace
// ---------------------------------------------------------------------------

function callerView(dashboard) {
  const { customer, bill, requests } = dashboard;
  const chip = `<div class="profile-chip"><span>${escape(customer.name.slice(0, 1))}</span><div><b>${escape(customer.name)}</b><small>${escape(customer.account_number)}</small></div></div>`;
  const live = state.connected;
  const disputed = Number(bill?.disputed_amount) > 0;

  const body = `
    <div class="caller-shell">
      <div class="caller-grid">

        <section class="call-card">
          <div class="call-head">
            <div class="call-label">
              <span class="eyebrow">BILLING SUPPORT LINE</span>
              <b>Maya's desk · AI cover</b>
            </div>
            <div class="call-state ${live ? "live" : ""}" id="voiceBadge">
              <i></i>${live ? "On the call" : "Ready"}
            </div>
          </div>

          <div class="orb-wrap">
            <div class="orb ${live ? "live" : ""}" id="voiceOrb">
              <span></span><span></span><span></span>
              <b>${live ? "◉" : "☎"}</b>
            </div>
          </div>

          <div class="call-copy">
            <h3>${live ? "Talk whenever you like" : "Start the billing support call"}</h3>
            <p>${live
              ? "Cut in at any point. It stops immediately, remembers exactly which of its words reached you, and never counts the rest as said."
              : "You will be speaking to an AI assistant covering for Maya. Interrupt it whenever you want — that is the part worth watching."}</p>
          </div>

          <div class="call-actions">
            <button class="call-button ${live ? "ending" : ""}" id="callButton">
              ${live ? "End call" : "Start call"}
            </button>
            <span class="call-hint">Headphones recommended · ${escape(state.voice)} voice${
              state.features?.voice?.engineAffectiveDialog ? " · expressive engine" : ""
            }</span>
          </div>

          <div class="call-caption">
            <span>LIVE</span>
            <p id="voiceStatus">${escape(state.caption || state.status)}</p>
          </div>
        </section>

        <div class="caller-stack">
          <section class="panel-card">
            <div class="card-title"><h3>Your account</h3><small>Live server truth</small></div>
            <div class="plan-row">
              <b>${escape(customer.plan_name)}</b>
              <strong>${money(customer.monthly_price)}<small>/mo</small></strong>
            </div>
            <p class="plan-desc">${escape(customer.plan_description)}</p>
            <div class="money-row">
              <span class="muted">${escape(bill?.period || "Latest bill")}</span>
              <b>${money(bill?.amount)}</b>
            </div>
            ${disputed
              ? `<div class="dispute">
                   <span>Disputed on this bill${bill.disputed_line_item ? `<br />${escape(bill.disputed_line_item)}` : ""}</span>
                   <b>${money(bill.disputed_amount)}</b>
                 </div>`
              : ""}
          </section>

          <section class="panel-card heard-card" id="hcrPanel">
            ${hcrPanelHtml(null)}
          </section>

          <section class="panel-card">
            <div class="card-title"><h3>Requests on file</h3><small>${requests.length} total</small></div>
            ${requests.length
              ? requests.slice(0, 4).map((request) => `
                  <div class="request-row">
                    <span>
                      <b>${escape(request.reference)}</b>
                      <small>${escape(request.status.replaceAll("_", " "))}</small>
                    </span>
                    ${request.amount == null
                      ? '<span class="status-tag">no amount</span>'
                      : `<span class="amount">${money(request.amount)}</span>`}
                  </div>`).join("")
              : '<p class="empty-note">No billing review has been raised yet. That is the correct starting state.</p>'}
          </section>

          <section class="panel-card v5-panel" id="v5Panel">
            ${v5PanelHtml()}
          </section>
        </div>
      </div>

      <section class="transcript-lab full-span" id="labHost" hidden></section>
    </div>`;

  shell(
    "Billing support call",
    `Direct Gemini Live · ${escape(state.voice)} voice · ${state.voiceStyleLabel || state.voiceStyle} delivery`,
    body,
    chip,
  );
  document.querySelector("#callButton").addEventListener("click", toggleCall);
  wireV5Panel();
}

function v5PanelHtml() {
  const features = state.features;
  if (!features) return '<p class="muted">V5 feature status is still loading.</p>';

  const locked = state.connected;
  const styleRow = features.voice.availableStyles.map((style) => `
    <button class="v5-style-button ${state.voiceStyle === style ? "active" : ""}"
            data-style="${escape(style)}" ${locked ? "disabled" : ""}>
      <b>${style === "baseline" ? "Baseline" : "Natural"}</b>
      <small>${style === "baseline"
        ? "Exactly the V4 wording"
        : "Same rules, one delivery instruction added"}</small>
    </button>`).join("");

  const helper = features.smartTranscript;
  const lab = features.transcriptLab;

  return `
    <div class="section-title"><h3>V5 experiment</h3><small>v${escape(features.build.version)}</small></div>

    <div class="v5-block">
      <span class="eyebrow">DELIVERY STYLE ${locked ? "· LOCKED FOR THIS CALL" : "· APPLIES TO THE NEXT CALL"}</span>
      <div class="v5-style-switch">${styleRow}</div>
      <p class="muted v5-note">Both styles use the same voice, the same model, the same tools and the same
      listening thresholds. Only one section of the assistant's instructions differs, and it cannot change a
      fact, a price or what the assistant is allowed to do.</p>
    </div>

    <div class="v5-block">
      <span class="eyebrow">VOICE ${locked ? "· LOCKED FOR THIS CALL" : "· APPLIES TO THE NEXT CALL"}</span>
      <div class="v5-voice-grid">
        ${(features.voice.auditionVoices || []).map((entry) => `
          <button class="v5-voice-button ${state.voice === entry.name ? "active" : ""}"
                  data-voice="${escape(entry.name)}" title="${escape(entry.why)}" ${locked ? "disabled" : ""}>
            <b>${escape(entry.name)}</b>
            <small>${escape(entry.descriptor)}${entry.baseline ? " · current" : ""}</small>
          </button>`).join("")}
      </div>
      <p class="muted v5-note">Google publishes a one-word descriptor per voice but no gender or accent,
      and these models pick the language themselves. So a descriptor is a reason to <b>audition</b> a
      voice, not evidence of how it sounds. Try a few and pick by ear.</p>
    </div>

    <div class="v5-block">
      <span class="eyebrow">EXPRESSION ${locked ? "· LOCKED FOR THIS CALL" : ""}</span>
      ${features.voice.expressiveAvailable
        ? `<div class="v5-style-switch">
             ${(features.voice.availableEngines || []).map((engine) => `
               <button class="v5-style-button ${state.engineMode === engine.id ? "active" : ""}"
                       data-engine="${escape(engine.id)}" ${locked ? "disabled" : ""}>
                 <b>${escape(engine.label)}${engine.experimental ? " ⚗" : ""}</b>
                 <small>${engine.affectiveDialog ? "Adapts tone to yours" : "Fixed delivery"}</small>
               </button>`).join("")}
           </div>
           <p class="muted v5-note">The expressive engine is a <b>different model</b> (Gemini 2.5), because
           Google documents tone adaptation as unsupported on the 3.1 model we use by default. Voice
           character, timing and turn-taking all change together, so treat any difference as
           unattributed until you have heard both. Unverified against this agent's tools.</p>`
        : `<div class="v5-status off"><b>Off</b><span>expressive engine disabled on this server</span></div>
           <p class="muted v5-note">Tone adaptation needs a different model (Gemini 2.5); the 3.1 model we
           run does not support it. Set <code>VOICE_EXPRESSIVE_ENABLED=true</code> to try it as an A/B.
           Deliberately off by default: it is unverified against this agent's tools and interruption path.</p>`}
    </div>

    <div class="v5-block">
      <span class="eyebrow">AUDIO PLAYBACK ${locked ? "· LOCKED FOR THIS CALL" : "· APPLIES TO THE NEXT CALL"}</span>
      <div class="v5-style-switch">
        ${(features.voice.availablePlaybackModes || []).map((mode) => `
          <button class="v5-style-button ${state.playbackMode === mode ? "active" : ""}"
                  data-playback="${escape(mode)}" ${locked ? "disabled" : ""}>
            <b>${mode === "continuous" ? "Clean" : "V4 original"}</b>
            <small>${mode === "continuous"
              ? "Output runs at the provider's own 24 kHz"
              : "Exactly as V4 did, tick included"}</small>
          </button>`).join("")}
      </div>
      <p class="muted v5-note">Gemini sends speech at 24 kHz. If the browser plays it into a context
      running at a different rate, it re-converts every chunk on its own and leaves a click at each
      chunk join &mdash; a faint repetitive tick under the voice. <b>Clean</b> removes that by matching
      the rate. <b>V4 original</b> is kept so the old behaviour stays reproducible for comparison.</p>
    </div>

    <div class="v5-block">
      <span class="eyebrow">NOISE-TRIGGERED STOPS ${locked ? "· LOCKED FOR THIS CALL" : "· NEXT CALL"}</span>
      <div class="v5-style-switch">
        ${["baseline", "conservative"].map(mode => `
          <button class="v5-style-button ${state.noiseMode === mode ? "active" : ""}"
                  data-noise="${mode}" ${locked ? "disabled" : ""}>
            <b>${mode === "baseline" ? "Baseline" : "Less sensitive · trial"}</b>
            <small>${mode === "baseline" ? "Current listening behaviour" : "Provider-native interruption setting"}</small>
          </button>`).join("")}
      </div>
      <p class="muted v5-note">The trial may reduce unwanted stops, but can also miss quiet interruptions.
      It does not remove another person's voice or identify the caller. Browser noise processing is still requested;
      no custom filter is enabled. Not yet compared in a real call.</p>
    </div>

    <div class="v5-block">
      <span class="eyebrow">TRANSCRIPT COMPARISON LAB</span>
      ${lab.enabled
        ? `<button class="v5-secondary-button" id="labToggle">${state.labOpen ? "Close the lab" : "Open the lab"}</button>
           <p class="muted v5-note">Compares the original machine transcript with a readable, machine-edited one,
           using a short recording you choose. ${lab.realProviderCallsEnabled
             ? "Real recogniser calls are enabled on this server."
             : "Real recogniser calls are switched off, so the lab will plan a run and show you exactly what it would send, without contacting anything."}</p>`
        : '<p class="muted v5-note">The transcript lab is switched off on this server.</p>'}
    </div>

    <div class="v5-block">
      <span class="eyebrow">LIVE TRANSCRIPT HELPER</span>
      <div class="v5-status ${helper.serverEnabled ? "on" : "off"}">
        <b>${helper.serverEnabled ? "Enabled" : "Off"}</b>
        <span>${escape(helper.blockers.join(", ").replaceAll("_", " ") || "no blockers")}</span>
      </div>
      <p class="muted v5-note">Deliberately unpromoted. ${escape(helper.promotionGate)}</p>
    </div>

    ${features.configurationErrors.length
      ? `<div class="v5-config-error"><span class="eyebrow">CONFIGURATION FELL BACK</span>
           ${features.configurationErrors.map((line) => `<p>${escape(line)}</p>`).join("")}</div>`
      : ""}

    <p class="muted v5-note v5-provenance">Voice model and speech recognition are Google Gemini's.
    Echo cancellation and noise suppression are the browser's WebRTC front end. We did not train either.</p>`;
}

/** Re-render the V5 panel in place and re-bind its controls. */
function refreshV5Panel() {
  const panel = document.querySelector("#v5Panel");
  if (!panel) return;
  panel.innerHTML = v5PanelHtml();
  wireV5Panel();
}

function wireV5Panel() {
  for (const button of document.querySelectorAll(".v5-style-button[data-noise]")) {
    button.addEventListener("click", () => {
      if (state.connected) return;
      state.noiseMode = button.dataset.noise === "conservative" ? "conservative" : "baseline";
      refreshV5Panel();
      showToast("The interruption sensitivity will apply to the next call.");
    });
  }
  for (const button of document.querySelectorAll(".v5-style-button[data-style]")) {
    button.addEventListener("click", () => {
      if (state.connected) {
        showToast("The delivery style is fixed for a call that is already running.", "error");
        return;
      }
      state.voiceStyle = button.dataset.style;
      refreshV5Panel();
      showToast(`Next call will use the ${state.voiceStyle} delivery style.`);
    });
  }

  for (const button of document.querySelectorAll(".v5-style-button[data-playback]")) {
    button.addEventListener("click", () => {
      if (state.connected) {
        showToast("Audio playback is fixed for a call that is already running.", "error");
        return;
      }
      state.playbackMode = button.dataset.playback;
      refreshV5Panel();
      showToast(`Next call will use ${state.playbackMode === "continuous" ? "clean" : "V4-original"} playback.`);
    });
  }

  for (const button of document.querySelectorAll(".v5-voice-button[data-voice]")) {
    button.addEventListener("click", () => {
      if (state.connected) {
        showToast("The voice is fixed for a call that is already running.", "error");
        return;
      }
      state.voice = button.dataset.voice;
      refreshV5Panel();
      showToast(`Next call will use the ${state.voice} voice.`);
    });
  }

  for (const button of document.querySelectorAll(".v5-style-button[data-engine]")) {
    button.addEventListener("click", () => {
      if (state.connected) {
        showToast("The engine is fixed for a call that is already running.", "error");
        return;
      }
      state.engineMode = button.dataset.engine;
      refreshV5Panel();
      showToast(`Next call will use the ${state.engineMode} engine.`);
    });
  }

  const toggle = document.querySelector("#labToggle");
  if (toggle) toggle.addEventListener("click", toggleLab);
}

/** Open or close the transcript lab. Closing tears down everything it owns. */
async function toggleLab() {
  const host = document.querySelector("#labHost");
  if (!host) return;

  if (state.labOpen) {
    try { state.labPanel?.destroy?.(); } catch { /* already gone */ }
    try { state.lab?.destroy?.(); } catch { /* already gone */ }
    state.labPanel = null;
    state.lab = null;
    state.labOpen = false;
    host.innerHTML = "";
    host.hidden = true;
  } else {
    host.hidden = false;
    host.innerHTML = '<p class="muted">Loading the transcript lab…</p>';
    try {
      const [{ createTranscriptLab }, { renderLabPanel }] = await Promise.all([
        transcriptLabModule(),
        transcriptPanelModule(),
      ]);
      state.lab = createTranscriptLab({
        features: state.features,
        requestToken: (request) => api("/api/v5/transcription/token", {
          method: "POST",
          body: JSON.stringify(request || {}),
        }),
        connect: async ({ model, config, token, callbacks }) => {
          const { GoogleGenAI } = await import("@google/genai");
          const ai = new GoogleGenAI({ apiKey: token.value, httpOptions: { apiVersion: "v1beta" } });
          return ai.live.connect({ model, config, callbacks });
        },
        decodeAudio: async (arrayBuffer) => {
          const context = new AudioContext();
          try {
            const buffer = await context.decodeAudioData(arrayBuffer);
            const channelData = [];
            for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
              channelData.push(buffer.getChannelData(channel));
            }
            return { channelData, sampleRate: buffer.sampleRate, duration: buffer.duration };
          } finally {
            void context.close();
          }
        },
        recorder: state.recorder,
      });
      host.innerHTML = "";
      state.labPanel = renderLabPanel(host, state.lab);
      state.labOpen = true;
    } catch (error) {
      host.innerHTML = `<p class="muted">The transcript lab could not start: ${escape(error.message)}</p>`;
    }
  }

  refreshV5Panel();
}

function hcrPanelHtml(snapshot) {
  const active = snapshot?.active;
  const remainder = snapshot?.pendingRemainder;
  const stateLabels = {
    planned: ["Preparing a reply", "Thinking about what to say"],
    speaking: ["Speaking to you now", "Words are reaching you"],
    played: ["Finished speaking", "Everything was delivered"],
    interrupted: ["You cut in", "The rest never reached you"],
    resumed: ["Carrying on", "Continuing where it stopped"],
    completed: ["Fully delivered", "Nothing was lost"],
  };
  const [label, sub] = stateLabels[active?.state] || ["Nothing being spoken", "Start a call to see this work"];
  const heardPercent = active && active.scheduledChunks
    ? Math.round((active.audibleChunks / active.scheduledChunks) * 100)
    : 0;

  return `
    <div class="card-title">
      <h3>What you actually heard</h3>
      <small>The heard-state ledger</small>
    </div>

    <div class="heard-state ${escape(active?.state || "idle")}">
      <b>${escape(label)}</b>
      <small>${escape(sub)}</small>
    </div>

    ${active
      ? `<div class="heard-bar"><i style="width:${heardPercent}%"></i></div>
         <div class="heard-legend">
           <span><i class="dot-heard"></i>${active.audibleChunks} of ${active.scheduledChunks} pieces reached you</span>
           <span><i class="dot-unheard"></i>${Math.max(0, active.scheduledChunks - active.audibleChunks)} cut off</span>
         </div>`
      : ""}

    ${active?.heardText ? `<p class="heard-quote">&ldquo;${escape(active.heardText)}&rdquo;</p>` : ""}

    ${remainder
      ? `<div class="heard-unheard">
           <span>NEVER REACHED YOU</span>
           <p>&ldquo;${escape(remainder.unheardText)}&rdquo;</p>
           <small>Quarantined. The assistant has been told not to treat this as something it said.</small>
         </div>`
      : ""}

    <div class="heard-counts">
      <div><b>${snapshot?.completed ?? 0}</b><small>fully delivered</small></div>
      <div><b>${snapshot?.interrupted ?? 0}</b><small>interrupted by you</small></div>
    </div>`;
}

function startHcrPolling() {
  stopHcrPolling();
  state.hcrTimer = setInterval(async () => {
    const panel = document.querySelector("#hcrPanel");
    if (!panel || !voice) return;
    panel.innerHTML = hcrPanelHtml(voice.heardStateSnapshot());
  }, 300);
}

function stopHcrPolling() {
  if (state.hcrTimer) clearInterval(state.hcrTimer);
  state.hcrTimer = null;
}

function setStatus(message) {
  state.status = message;
  // The caption strip shows whichever of the two sides spoke most recently, so
  // a judge watching from across the room can follow the conversation.
  state.caption = message;
  const node = document.querySelector("#voiceStatus");
  if (node) node.textContent = message;
}

function noteActivity(message) {
  state.activity.unshift(message);
  state.activity = state.activity.slice(0, 12);
  const node = document.querySelector("#activityLine");
  if (node) node.textContent = message;
}

/**
 * Guards `toggleCall` against re-entry.
 *
 * The button is a DOM node that gets replaced on every re-render, and disabling
 * it only helps *after* the first await. A second click (or a stray synthetic
 * one) arriving during the module import or either network round-trip would
 * otherwise start a second Gemini session: the voice core's own
 * `if (activeSession) return` guard is not armed until after
 * `ai.live.connect()` resolves. Two sessions then interleave their audio onto
 * one shared playback cursor, which clicks at every chunk boundary.
 *
 * A plain module-level flag closes the window, because it is set synchronously
 * before anything is awaited.
 */
let callTransitionInFlight = false;

async function toggleCall() {
  if (callTransitionInFlight) return;
  callTransitionInFlight = true;
  const button = document.querySelector("#callButton");
  if (button) button.disabled = true;
  const module = await voiceModule();
  try {
    if (state.connected) {
      module.disconnectVoiceAgent();
      stopHcrPolling();
      state.connected = false;
      state.recorder = null;
      setStatus("Call ended");
      noteActivity("Call ended. The flight recorder report is available to the billing team.");
    } else {
      state.recorder = createFlightRecorderClient({ token: state.token, scenario: state.scenario });
      await module.connectVoiceAgent({
        token: state.token,
        customer: state.me?.profile || {},
        recorder: state.recorder,
        onStatus: setStatus,
        onToolEvent: noteActivity,
        // Fixed for the whole call. The UI locks the selector while connected.
        voiceStyle: state.voiceStyle,
        playbackMode: state.playbackMode,
        voice: state.voice,
        voiceMode: state.engineMode,
        noiseMode: state.noiseMode,
        features: state.features,
      });
      state.connected = true;
      startHcrPolling();
    }
  } catch (error) {
    showToast(error.message, "error");
    setStatus(error.message);
    state.connected = false;
  } finally {
    callTransitionInFlight = false;
    // `button` may have been replaced by a re-render; re-query rather than
    // touching a detached node.
    const current = document.querySelector("#callButton");
    if (current) current.disabled = false;
    const dashboard = await api("/api/customer/dashboard");
    callerView(dashboard);
  }
}

// ---------------------------------------------------------------------------
// Billing-team workspace: the Call Flight Recorder
// ---------------------------------------------------------------------------

function gateRow(label, value, target, passed, note) {
  return `
    <div class="gate-row ${passed === null ? "unknown" : passed ? "pass" : "fail"}">
      <span>${escape(label)}</span>
      <b>${escape(value)}</b>
      <em>${escape(target)}</em>
      <small>${escape(note)}</small>
    </div>`;
}

function gateScorecard(report) {
  const metrics = report.metrics;
  const responseP95 = metrics.response_latency_p95_ms;
  const stopP95 = metrics.audible_stop_p95_ms;
  const outcomes = metrics.interruption_outcomes_measured;
  const preservation = outcomes ? metrics.preserved_or_resumed / outcomes : null;
  return `
    <div class="gate-card">
      <div class="section-title"><h3>Gate scorecard for this call</h3><small>Plan targets</small></div>
      ${gateRow("Response latency p95", ms(responseP95), "≤ 2,500 ms",
        responseP95 == null ? null : responseP95 <= 2500, "From your speech ending to the first audio scheduled.")}
      ${gateRow("Audible stop p95", ms(stopP95), "≤ 500 ms",
        stopP95 == null ? null : stopP95 <= 500, "Browser-estimated speech start plus an exact playback clear.")}
      ${gateRow("Playback clear p95", ms(metrics.playback_clear_p95_ms), "exact measure",
        metrics.playback_clear_p95_ms == null ? null : true, "Time to drop every queued audio buffer. Exact.")}
      ${gateRow("Explanation preserved", preservation == null ? "—" : `${metrics.preserved_or_resumed}/${outcomes} (${percent(preservation)})`, "≥ 9 in 10",
        preservation == null ? null : preservation >= 0.9, "Estimated from how much of the unheard tail came back.")}
      ${gateRow("Reintroductions after an interruption", String(metrics.suspected_reintroductions), "0",
        metrics.suspected_reintroductions === 0, "Estimated by overlap with the opening line.")}
      ${gateRow("Wrong or duplicate business actions", String(report.database_match.duplicate_executions), "0",
        report.database_match.duplicate_executions === 0, "Confirmed intents versus rows actually written.")}
      ${gateRow("Money issued", money(report.database_match.money_issued), "₹0",
        report.database_match.money_issued === 0, "The Twin has no money-movement authority at all.")}
      ${gateRow("Report matches the database", report.database_match.matches ? "Yes" : "No", "Yes",
        report.database_match.matches, "Browser timeline reconciled against the real rows.")}
    </div>`;
}

const EVENT_LABELS = {
  session_started: "Call recording started",
  socket_opened: "Gemini connection opened",
  microphone_ready: "Microphone ready",
  audio_frontend_ready: "Browser echo cancellation, noise suppression and gain control active",
  user_speech_started: "Caller started making sound*",
  user_speech_ended: "Caller stopped*",
  input_transcript_received: "Caller transcript",
  response_planned: "Assistant began a new reply",
  response_audio_started: "Assistant audio started",
  output_transcript_received: "Assistant transcript",
  agent_speech_ended: "Assistant finished speaking",
  response_interrupted: "Interrupted · playback cleared",
  heard_state_transition: "Heard-state changed",
  unheard_content_quarantined: "Unheard words quarantined",
  resume_context_injected: "Heard-state note pushed back to the model",
  resume_context_failed: "Heard-state note could not be pushed",
  tool_requested: "Tool requested",
  tool_completed: "Tool completed",
  tool_failed: "Tool failed",
  tool_policy_blocked: "Policy blocked an unsafe action",
  action_prepared: "Action prepared · nothing changed yet",
  action_committed: "Action executed exactly once",
  action_blocked: "Action blocked",
  usage_updated: "Token usage",
  session_ended: "Call ended",
  error: "Runtime error",
};

function reportDetail(report) {
  const transcript = report.transcript.length
    ? report.transcript.map((line) => `
        <div class="transcript-line ${line.speaker}">
          <span>${line.speaker === "customer" ? "Caller" : "Assistant"}<small>${seconds(line.at_ms)}</small></span>
          <p>${escape(line.text)}</p>
        </div>`).join("")
    : '<div class="empty-mini">No transcript was captured for this call.</div>';

  const heard = report.heard_state_timeline.length
    ? report.heard_state_timeline.map((epoch) => `
        <div class="heard-row ${escape(epoch.state)}">
          <span>${escape(epoch.state)}</span>
          <b>${epoch.audible_chunks} played</b>
          ${epoch.unheard_text ? `<em>unheard: “${escape(epoch.unheard_text)}”</em>` : "<em>fully delivered</em>"}
        </div>`).join("")
    : '<div class="empty-mini">No assistant reply was recorded.</div>';

  const interruptions = report.interruption_timeline.length
    ? report.interruption_timeline.map((item, index) => `
        <div class="latency-line">
          <span>Interruption ${index + 1}</span>
          <b>${ms(item.audible_stop_ms)}</b>
          <em class="metric-band ${item.audible_stop_ms != null && item.audible_stop_ms <= 500 ? "good" : "bad"}">audible stop</em>
          <small>clear ${ms(item.playback_clear_ms)} · ${item.queued_sources_cleared} buffers dropped · at ${seconds(item.at_ms)}</small>
        </div>`).join("")
    : '<div class="empty-mini">The caller never spoke over the assistant on this call.</div>';

  const outcomes = report.interruption_outcomes.length
    ? report.interruption_outcomes.map((item) => `
        <div class="latency-line">
          <span>${escape(item.estimate.replaceAll("_", " "))}</span>
          <b>${percent(item.resume_coverage)}</b>
          <small>of the unheard tail came back · ${escape(item.precision)}</small>
        </div>`).join("")
    : '<div class="empty-mini">No interruption outcome could be estimated.</div>';

  const actions = [
    ...report.action_timeline.prepared.map((item) => ({ ...item, kind: "prepared" })),
    ...report.action_timeline.committed.map((item) => ({ ...item, kind: "committed" })),
    ...report.action_timeline.blocked.map((item) => ({ ...item, kind: "blocked" })),
  ].sort((a, b) => a.at_ms - b.at_ms);
  const actionRows = actions.length
    ? actions.map((item) => `
        <div class="latency-line">
          <span>${escape(item.kind)}${item.request_type ? ` · ${escape(item.request_type.replaceAll("_", " "))}` : ""}</span>
          <b>${escape(item.reference || item.code || item.intent_id || "—")}</b>
          <small>${escape(item.reason || "")} at ${seconds(item.at_ms)}</small>
        </div>`).join("")
    : '<div class="empty-mini">No business action was attempted.</div>';

  const rows = report.events.map((event) => `
    <div class="raw-event ${["response_interrupted", "action_blocked", "error"].includes(event.event_type) ? "problem" : ""}">
      <time>${seconds(event.at_ms)}</time>
      <span>${escape(EVENT_LABELS[event.event_type] || event.event_type.replaceAll("_", " "))}</span>
      <b>${event.duration_ms == null ? "" : ms(event.duration_ms)}</b>
    </div>`).join("");

  return `
    <div class="conversation-detail-grid">
      ${gateScorecard(report)}
      ${v5ExperimentSection(report)}
      <section><h4>Full transcript</h4><div class="transcript-list">${transcript}</div></section>
      <section><h4>Heard state, reply by reply</h4><div class="latency-list">${heard}</div></section>
      <section><h4>Interruption timing</h4><div class="latency-list">${interruptions}</div></section>
      <section><h4>What happened after each interruption</h4><div class="latency-list">${outcomes}</div></section>
      <section><h4>Business actions</h4><div class="latency-list">${actionRows}</div></section>
      <section><h4>Final database state</h4><div class="latency-list">
        ${report.database_state.review_requests.map((request) => `<div class="latency-line"><span>${escape(request.reference)}</span><b>${escape(request.status.replaceAll("_", " "))}</b><small>${request.amount == null ? "no amount" : money(request.amount)} · ${dateTime(request.created_at)}</small></div>`).join("")}
        ${report.database_state.plan_changes.map((change) => `<div class="latency-line"><span>Plan change</span><b>${escape(change.status)}</b><small>${escape(change.from_plan_id)} → ${escape(change.to_plan_id)}</small></div>`).join("")}
        ${!report.database_state.review_requests.length && !report.database_state.plan_changes.length ? '<div class="empty-mini">Nothing was written. That is the correct outcome for a call with no confirmed request.</div>' : ""}
      </div></section>
      <p class="muted footnote">* Caller speech boundaries come from a browser energy estimate. They are reported for timing only and never authorise an action.</p>
      <details class="raw-timeline"><summary>Show every recorded event (${report.events.length})</summary><div>${rows}</div></details>
    </div>`;
}

/**
 * The V5 experiment block in a call report.
 *
 * Kept visually and structurally separate from the gate scorecard, because
 * none of it is a gate result: it records which configuration ran and what the
 * transcript lanes did, and it says so.
 */
function v5ExperimentSection(report) {
  const experiment = report.v5_experiment;
  if (!experiment || (!experiment.configured && !experiment.transcript_lanes?.length)) return "";
  const configured = experiment.configured;

  const configRows = configured
    ? `
      <div class="latency-line"><span>Delivery style</span><b>${escape(configured.voice_style_effective || "unknown")}</b>
        <small>${configured.style_fell_back
          ? `requested ${escape(String(configured.voice_style_requested))}, fell back to baseline`
          : "as requested"}</small></div>
      <div class="latency-line"><span>Prompt fingerprint</span><b>${escape(configured.prompt_fingerprint || "—")}</b>
        <small>${configured.prompt_characters ?? "—"} characters · ${escape(configured.fingerprint_kind || "")}</small></div>
      <div class="latency-line"><span>Voice model</span><b>${escape(configured.voice_model || "—")}</b>
        <small>voice ${escape(configured.voice_name || "—")} · build ${escape(configured.build_version || "—")}</small></div>
      <div class="latency-line"><span>Features on this call</span>
        <b>${configured.smart_transcript_enabled ? "helper on" : "helper off"}</b>
        <small>${configured.transcript_lab_enabled ? "lab available" : "lab off"}</small></div>`
    : '<div class="empty-mini">This call ran without the V5 experiment block.</div>';

  const laneRows = experiment.transcript_lanes?.length
    ? experiment.transcript_lanes.map((lane) => `
        <div class="latency-line">
          <span>${escape(lane.label || lane.lane_id)}</span>
          <b>${escape(lane.final_state || "unknown")}</b>
          <small>${lane.final_segments} final segments · setup ${ms(lane.setup_ms)} ·
          end-to-final p95 ${ms(lane.end_to_final_p95_ms)} · queue peak ${lane.queue_high_water_mark ?? "—"} ·
          gaps ${lane.stream_gaps ?? 0} · usage ${lane.usage_known ? "reported" : "unknown"}</small>
        </div>`).join("")
    : '<div class="empty-mini">No dedicated transcript lane ran on this call.</div>';

  const playback = experiment.playback;
  const playbackRows = playback
    ? `
      <div class="latency-line">
        <span>Playback mode</span><b>${escape(playback.mode || "unknown")}</b>
        <small>output context ${playback.actual_sample_rate ?? "?"} Hz vs provider
        ${playback.provider_output_sample_rate ?? "?"} Hz${playback.fallback_reason
          ? ` · fell back: ${escape(playback.fallback_reason)}` : ""}</small>
      </div>
      <div class="latency-line ${playback.per_chunk_resampling ? "problem" : ""}">
        <span>Per-chunk resampling</span>
        <b>${playback.per_chunk_resampling === null ? "—" : playback.per_chunk_resampling ? "YES" : "no"}</b>
        <small>${playback.per_chunk_resampling
          ? "The browser re-converted every chunk, so there is a click at each chunk join — the periodic tick."
          : "Rates match, so chunk boundaries are sample-exact."}</small>
      </div>
      <div class="latency-line">
        <span>Scheduler gaps</span>
        <b>${playback.gaps_inserted ?? 0} / ${playback.chunks_scheduled ?? "?"} chunks</b>
        <small>worst ${ms(playback.worst_gap_ms)} · total ${ms(playback.total_gap_ms)} of inserted silence ·
        ${escape(playback.gap_precision || "")}</small>
      </div>`
    : '<div class="empty-mini">No playback measurement on this call.</div>';

  return `
    <section class="v5-report-block">
      <h4>V5 experiment · not a gate result</h4>
      <h4>Audio playback quality</h4>
      <div class="latency-list">${playbackRows}</div>
      <div class="latency-list">${configRows}</div>
      <h4>Transcript lanes</h4>
      <div class="latency-list">${laneRows}</div>
      <p class="muted footnote">${escape(experiment.authority_note || "")}</p>
      <p class="muted footnote">Alignment: ${escape(experiment.alignment?.quality || "unknown")}.
      ${escape(experiment.alignment?.note || "")}</p>
    </section>`;
}

function employeeView(dashboard) {
  const { stats, pending, ledger, voice: voiceInfo, reports } = dashboard;
  const chip = `<div class="profile-chip"><span>M</span><div><b>Maya</b><small>Billing Support</small></div></div>`;

  const reportRows = reports.length
    ? reports.map((report) => `
        <tr class="conversation-summary-row" tabindex="0" role="button" aria-expanded="false">
          <td><b>${escape(report.customer_name)}</b><small>${dateTime(report.started_at)}</small></td>
          <td>${ms(report.duration_ms)}</td>
          <td>${report.metrics.interruptions}</td>
          <td>${ms(report.metrics.audible_stop_p95_ms)}</td>
          <td>${ms(report.metrics.response_latency_p95_ms)}</td>
          <td>${report.metrics.actions_committed} committed · ${report.metrics.actions_blocked} blocked</td>
          <td>${report.database_match.matches ? "matched" : "MISMATCH"}<span class="expand-cue">Details⌄</span></td>
        </tr>
        <tr class="conversation-detail-row" hidden><td colspan="7">${reportDetail(report)}</td></tr>`).join("")
    : '<tr><td colspan="7" class="empty-mini">No call has been recorded yet. Sign in as the caller and start one.</td></tr>';

  const body = `
    <div class="dashboard-content">
      <div class="stat-grid">
        <div class="panel stat-card"><small>Pending human reviews</small><b>${stats.pendingReviews}</b></div>
        <div class="panel stat-card"><small>Requests prepared</small><b>${stats.preparedIntents}</b></div>
        <div class="panel stat-card"><small>Confirmed and executed</small><b>${stats.completedIntents}</b></div>
        <div class="panel stat-card"><small>Cancelled by a correction</small><b>${stats.supersededIntents}</b></div>
        <div class="panel stat-card good"><small>Money issued by the Twin</small><b>${money(stats.moneyIssued)}</b></div>
      </div>

      <section class="panel ledger-card full-span">
        <div class="section-title"><h3>Call Flight Recorder</h3><small>${escape(voiceInfo.model)} · ${escape(voiceInfo.turnDetection.replaceAll("-", " "))}</small></div>
        <table class="report-table">
          <thead><tr><th>Call</th><th>Length</th><th>Interruptions</th><th>Audible stop p95</th><th>Response p95</th><th>Actions</th><th>Reconciliation</th></tr></thead>
          <tbody>${reportRows}</tbody>
        </table>
      </section>

      <section class="panel review-card full-span">
        <div class="section-title"><h3>Queue for a human specialist</h3><small>${pending.length} waiting</small></div>
        ${pending.length
          ? pending.map((request) => `
              <div class="bill-row">
                <span><b>${escape(request.reference)}</b><br /><small class="muted">${escape(request.customer_name)} · ${escape(request.reason)}</small></span>
                <b>${request.amount == null ? "no amount" : money(request.amount)}</b>
              </div>`).join("")
          : '<p class="muted">Nothing is waiting for a human right now.</p>'}
      </section>

      <section class="panel ledger-card full-span">
        <div class="section-title"><h3>HCR ledger</h3><small>Last ${ledger.length}</small></div>
        ${ledger.length
          ? ledger.slice(0, 12).map((entry) => `
              <div class="bill-row">
                <span><b>${escape(entry.stage.replaceAll("_", " "))}</b><br /><small class="muted">${escape(entry.detail)}</small></span>
                <b class="${entry.state === "blocked" ? "bad" : ""}">${escape(entry.state.replaceAll("_", " "))}</b>
              </div>`).join("")
          : '<p class="muted">The ledger is empty.</p>'}
      </section>
    </div>`;

  shell("Call Flight Recorder", "Every interruption, every heard word, every business action", body, chip);
  wireReportRows();
}

function wireReportRows() {
  for (const row of document.querySelectorAll(".conversation-summary-row")) {
    const toggle = () => {
      const detail = row.nextElementSibling;
      const expanded = row.getAttribute("aria-expanded") !== "true";
      row.setAttribute("aria-expanded", String(expanded));
      detail.hidden = !expanded;
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        toggle();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadWorkspace() {
  try {
    state.me = await api("/api/me");
    // The server is authoritative for every V5 switch. A failure here leaves
    // the V5 panel reporting "still loading" rather than guessing a default
    // that might claim a disabled feature is on.
    try {
      state.features = await api("/api/v5/features");
      state.voiceStyle = state.features.voice.defaultStyle;
      state.playbackMode = state.features.voice.playbackMode;
      state.voice = state.features.voice.voice;
      state.engineMode = state.features.voice.engineMode;
    } catch {
      state.features = null;
    }
    if (state.me.role === "customer") {
      callerView(await api("/api/customer/dashboard"));
    } else {
      employeeView(await api("/api/employee/dashboard"));
    }
  } catch (error) {
    showToast(error.message, "error");
    clearV5Storage();
    state.token = null;
    loginView();
  }
}

window.addEventListener("beforeunload", () => {
  if (voice && state.connected) voice.disconnectVoiceAgent();
  try { state.labPanel?.destroy?.(); } catch { /* page is going away anyway */ }
  try { state.lab?.destroy?.(); } catch { /* page is going away anyway */ }
});

if (state.token) loadWorkspace(); else loginView();
