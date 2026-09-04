# Personal-number phone demo on a nearby Ubuntu VM

Research and repository review: **4 September 2026**. Status: **plan only; phone connection unverified**.

## What should we do first?

**Prepare a small Ubuntu VM, test the phone connection, and then copy V5 into it.** We should not move the whole project before finding out whether the VM can exchange call audio with your phone.

In simple terms, we first make the computer work like a headset for your Xiaomi. Once that works, we replace the test voice with the agent.

The order is:

1. Identify the computer that will actually be beside you at the demo.
2. Start Ubuntu there and give it access to the computer's Bluetooth adapter.
3. Receive a real phone call and prove that sound travels both ways, without AI.
4. Disconnect the bridge and check that your phone works normally again.
5. Copy V5 to Ubuntu and check its existing browser voice behavior.
6. Connect the phone audio to the same Gemini agent.
7. Add and test a clear **Demo on / Demo off** control.

We can prepare the migration checklist in parallel with the phone research. The actual integration should follow these checks in order.

## Your setup and the proposed call path

| Item | Current understanding |
| --- | --- |
| Phone | Xiaomi 11i, Indian +91 Jio SIM, your existing personal number |
| Company phone line | None available |
| Demo computer | A computer near the phone; its exact hardware is still to be identified |
| Ubuntu VM | Preferred location is that nearby computer; approximately 32 GB RAM and 200 GB storage reported |
| Spending | No additional spending; use available equipment, existing included phone/internet usage and eligible Gemini free quota |
| Expected use | One demo caller at a time; normal personal-phone use when the demo is off |

A **VM** is a computer running inside another computer. A **bridge** is the small connection that carries the call's sound between your phone and the agent.

Proposed path, with speech travelling in both directions:

**Caller dials your Jio number ↔ your Xiaomi ↔ Bluetooth ↔ nearby Ubuntu VM ↔ V5 phone connector ↔ Gemini.**

Inside Ubuntu, the first candidate is **Asterisk**, free telephone software whose mobile module documents receiving cellular calls through Bluetooth phones. It would hand the sound to our own small Gemini connector. This specific Xiaomi/adapter/VM combination has not been tested. [Asterisk mobile features](https://docs.asterisk.org/Configuration/Channel-Drivers/Mobile-Channel/Mobile-Channel-Features/), [physical requirements](https://docs.asterisk.org/Configuration/Channel-Drivers/Mobile-Channel/Mobile-Channel-Requirements/).

**This route does not need Jio call forwarding.** Your Xiaomi receives the call on its current number. Jio's forwarding feature instead requires another destination phone number, which you do not currently have for the agent. A website address cannot fill that destination field. [Jio forwarding instructions](https://www.jio.com/help/faq/mobile/services/hd-voice/how-can-i-activate-call-forwarding-service/).

Example: a friend calls your number. The agent starts explaining a billing review. Your friend interrupts: “Wait, use the other charge.” The agent should stop speaking, understand the correction, and create one review only after the existing confirmation requirements are met. We must test what your friend actually hears through the telephone.

## Step 1 — identify the actual demo computer

Write down these items before selecting installation instructions:

- The computer's operating system, such as Windows or Linux.
- The VM software and version, such as VirtualBox or VMware.
- The Ubuntu version and whether it has a desktop interface.
- Whether the computer already has a Bluetooth adapter that Ubuntu can use.
- Whether the stated 32 GB RAM belongs to the physical computer or is available to the VM. Leave enough resources for the physical computer itself.

The stated RAM and storage do not appear to be the main obstacle for this design: Gemini runs remotely, while Ubuntu handles the app and call transport. This is an engineering assessment, not a performance benchmark. Bluetooth access, CPU scheduling and network stability still need testing.

Do not use this workspace laptop's hardware inventory as proof about a different demo computer. We do not need your full phone number for this planning step.

**Pass:** we know which physical computer, VM software and Bluetooth adapter we are testing.

## Step 2 — let Ubuntu use the real Bluetooth adapter

**Pass-through** means letting Ubuntu use a real piece of hardware attached to the physical computer. A virtual speaker or an internet connection is not the same as Bluetooth pass-through.

| VM software | Research finding | Decision for this demo |
| --- | --- | --- |
| Current VirtualBox 7.x base package | Free/open-source base; USB 2/3 support has been in the base since version 7.0. Direct USB-device access is documented. | First candidate if choosing software on a Windows computer. Test the actual adapter. |
| Current VMware Workstation Pro | Free for commercial use too, but its old Bluetooth-sharing feature was removed in 17.6. | If already supplied, investigate direct assignment of the USB Bluetooth adapter. Do not follow old “Share Bluetooth devices” tutorials. |
| Hyper-V | Microsoft documents no native USB pass-through. Remote-desktop device sharing does not establish this Ubuntu Bluetooth route. | Avoid as the first platform for this experiment. |
| KVM/libvirt on an existing Linux computer | Host USB-device assignment is documented. | Reasonable if this is already the available environment. |

Sources: [VirtualBox 7.0 change record](https://www.virtualbox.org/wiki/Changelog-7.0), [VirtualBox 7.2 components](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/Introduction.html), [USB settings](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/working-with-vms.html#settings-usb), [VMware free-use announcement](https://blogs.vmware.com/cloud-foundation/2024/11/11/vmware-fusion-and-workstation-are-now-free-for-all-users/), [VMware 17.6 release notes](https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/workstation-pro/17-0/release-notes/vmware-workstation-176-pro-release-notes.html), [Microsoft limitation](https://learn.microsoft.com/en-us/troubleshoot/windows-server/virtualization/usb-device-hyper-v-virtual-machine), [libvirt USB assignment](https://libvirt.org/formatdomain.html#usb-pci-scsi-devices).

For VirtualBox, use the current base package for this experiment. The separately licensed Extension Pack is unnecessary for the proposed USB assignment. Old advice saying USB 2/3 requires that pack is outdated. [Current Extension Pack licence](https://www.virtualbox.org/wiki/VirtualBox_PUEL).

The actual check:

1. Start the minimal Ubuntu VM on the intended computer.
2. Assign only the identified Bluetooth device to Ubuntu, if the VM software supports it.
3. Confirm Ubuntu sees a physical Bluetooth controller.
4. Pair the Xiaomi with Ubuntu.
5. Confirm we can release the device back to the physical computer afterward.

While Ubuntu owns the adapter, the physical computer may lose its Bluetooth connections. This matters if its keyboard or mouse uses that same adapter. Do not capture every USB device with a broad filter. [VirtualBox USB behavior](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/working-with-vms.html#settings-usb).

**Pass:** Ubuntu sees and can use the real adapter. Pairing alone does not pass the next call-audio check.

**If it fails:** record the exact device and failure. Try already-owned or borrowed compatible equipment if available. Do not purchase a dongle or migrate V5 to disguise a hardware blocker.

## Step 3 — test one real call without the agent

Use Ubuntu, the paired phone and Asterisk's mobile module. This may require enabling/building an optional module; installation instructions must match the actual Ubuntu and Asterisk versions. The official mobile documentation includes older examples, so it is not a ready-made Xiaomi installation guarantee.

The current Asterisk 22 source still includes `chan_mobile`, but it is disabled by default and has extended support. Its documented limit is one connected phone per Bluetooth adapter. [Current module source](https://github.com/asterisk/asterisk/blob/22/addons/chan_mobile.c), [mobile concepts](https://docs.asterisk.org/Configuration/Channel-Drivers/Mobile-Channel/Mobile-Channel-Concepts/).

Test in this order:

1. Have someone make an ordinary call to your number using their existing phone plan.
2. Use a manual answer step for the initial test.
3. Check that the caller's speech reaches the Ubuntu call path.
4. Play a short local speech clip back through that path and have the caller confirm they hear it clearly.
5. Hang up from the caller's phone; check that Ubuntu releases the call.
6. Repeat, ending the call from the demo side.
7. Disable/disconnect the bridge. Make a fresh call and confirm the Xiaomi rings and works normally.

You do not need to acquire another SIM; a friend's existing phone can place the test call. Included usage must cover it. No Gemini request is needed for these checks.

**Pass:** intelligible sound in both directions, reliable hang-up, and normal handset behavior after disconnecting. “Paired successfully” or “music plays over Bluetooth” is insufficient.

**If it fails:** diagnose the named issue before adding AI. A PipeWire headset-mode route is a reserve candidate if Asterisk cannot expose usable audio; run only one Bluetooth call manager at a time. WirePlumber documents the relevant hands-free role, but this is also unverified on your phone. [WirePlumber Bluetooth configuration](https://pipewire.pages.freedesktop.org/wireplumber/daemon/configuration/bluetooth.html).

## Step 4 — copy V5 to Ubuntu

Once Step 3 passes, **copy** V5 into a separate Ubuntu folder and retain the working Windows copy. This keeps a fallback available.

The repository review found a normal Node web application, a local SQLite database and browser-based Gemini audio. It did not find a ready-made phone connector. The migration is therefore a separate job from connecting telephone sound.

Copy the source, locked dependency list and documentation; reinstall dependencies for Ubuntu. Do not copy Windows-installed dependencies. Follow the exact migration checklist below.

**Pass:** Ubuntu passes V5's automated tests and build, then serves the expected login/account screens with its own demo database. This establishes application migration, not telephone readiness.

## Step 5 — check the existing voice agent on Ubuntu

Verify that the actual Gemini project has eligible free quota before making a model call. Google's current pricing lists free-tier availability for Gemini 3.1 Flash Live, but that does not prove the billing status or remaining quota of our specific project. Keep paid fallback disabled; do not enable billing to get through the demo. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [project quota guidance](https://ai.google.dev/gemini-api/docs/rate-limits).

Run one short browser conversation with the phone connector still off. The agent speaks; you interrupt and correct the request; the existing policy handles the correction. Use the established voice/model settings and leave optional experiments at their approved defaults.

If using a browser inside Ubuntu, use Ubuntu's localhost address. If using the physical computer's browser, provide a localhost forwarding connection or properly trusted HTTPS. Plain `http://VM-IP` cannot be assumed to allow browser microphone access. [Browser microphone requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

Moving the server does not move the microphone: a Windows browser still uses Windows audio devices. The planned phone connector will run beside Asterisk inside Ubuntu so that it can access Ubuntu's call audio directly.

**Pass:** the existing browser voice baseline works on the new setup. Record any migration regression before adding telephone audio.

## Step 6 — add the removable phone connector

Build one small, separate V5 component that receives call sound from Asterisk and exchanges it with the existing direct Gemini voice model. Reuse the server's account binding, tools and confirmation policy. This component is proposed; it does not exist yet.

Keep the first workflow to **billing-review intake**: gather the relevant charge, obtain the existing required confirmation, and create one review record for a human team. The agent must not issue a refund. Plan changes remain a backup workflow.

First use manual answering. Check that the caller can speak and hear responses, then interrupt while the agent is talking. Audio cancellation must reach the telephone output path as well as the model session. Record what is heard at the caller's phone; the browser's old playback counters cannot establish that.

**Pass:** one short real telephone conversation, one audible interruption, correct recovery, clean hang-up, and exactly one confirmed review record. An interrupted or unconfirmed request must not create that record.

Engineering boundaries and the specific audio-conversion work are listed below. No second AI model, separate speech service or new hosted telephony provider is part of this plan.

## Step 7 — make the demo easy to turn on and off

The following is required behavior to build and test, not an existing switch:

| State | What you should see and what it should do |
| --- | --- |
| **Off** | Personal phone operates normally. No automatic answering; no phone audio retained by the bridge. This is also the default after a restart. |
| **Starting** | Check the phone link, audio bridge, V5 connection and Gemini availability. Do not answer automatically while preparing. |
| **Ready** | Before answering, confirm the phone connection, prepared audio route and active Gemini session. The handset's call audio may become available only after answering; immediately verify it starts, and end the demo call with a clear error if it does not. |
| **In call** | One caller is connected. Show an obvious end-call control. Do not admit a second agent call. |
| **Stopping** | Stop admitting calls. Finish or explicitly end the current demo call, clear queued sound, close the model session, and release phone audio/control. |
| **Error** | Disable automatic answering and show the specific failed connection. Release the bridge where possible and check the handset. |

For the first version, turn the demo off between calls. If switching off during a call is needed, explicitly end that demo call and restore normal operation for the next call. Seamless transfer of an active call back to the handset is a separate unverified feature.

Automatic answering comes only after manual calling works. Asterisk's WebSocket channel answers by default when its media connection opens; the integration must deliberately use its documented no-auto-answer behavior and answer only after readiness checks. Simply starting the adapter must not answer someone's call. [Asterisk WebSocket answer controls](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/).

**Pass:** three complete on/off cycles, each followed by a normal handset call. Also test loss of Bluetooth or Gemini: no automatic answering when a required connection is known to be unavailable, no stuck session, and a clear recovery path. A failure can occur just after answering; detect it and promptly end the failed demo call rather than leaving the caller in silence. Return-to-normal is a physical check, not just an “Off” label.

## Stop rules and alternatives

| Obstacle | Next useful action |
| --- | --- |
| VM cannot use the existing Bluetooth adapter | Try a compatible already-available adapter/computer, or Linux already running directly on nearby equipment. Record the actual failure before changing platform. |
| Ubuntu pairs but call audio fails | Inspect the Asterisk mobile link first; consider the documented PipeWire headset route as one bounded alternative. |
| No usable digital handset bridge on available equipment | A manual speakerphone trial is a last-resort experiment; reject it if echo or feedback breaks interruption. It is not an automatic-forwarding solution. |
| Gemini free quota is unavailable | Continue local call/audio testing without AI; pause the AI telephone demo until eligible quota is available. Do not switch to a paid route automatically. |
| The VM later becomes a remote server | Keep a physical phone bridge near the Xiaomi and add a network link to the server. This is additional work; a remote VM cannot reach a nearby Bluetooth phone by itself. |
| No real-call route passes within the available setup | Keep V5's browser demo as the direct-provider voice core and label it accurately. It does not satisfy ordinary-number dial-in. |

We found no validated completely software-only route from this personal Jio number directly into a remote VM without a local bridge or another telephone destination. This is a finding within the searched sources, not a claim that every possible approach has been disproved. Ordinary Android app microphone permission does not grant capture of the cellular call stream. [Android call-audio restrictions](https://developer.android.com/media/platform/sharing-audio-input).

## Migration checklist for implementation

This section is for carrying out Step 4 later. No transfer has happened during this research.

### Files and runtime

- Copy `src/`, `server/`, `scripts/`, `tests/`, `docs/`, `package.json`, `package-lock.json`, `index.html`, `vite.config.js`, `README.md`, `AGENTS.md`, `.gitignore`, `.env.example`, and this plan.
- Preserve the parent `AGENTS.md`, `VISION_AND_SCOPE_GUARD.md` and relevant `research/` documents so their relative links remain usable.
- Preserve one existing test fixture: copy only V4's non-secret `vite.config.js` into its same sibling-relative location. V5's `tests/port-guard.test.js` reads it. No V1–V4 runtime, settings, credentials or database is required. Do not modify the frozen originals.
- Exclude Windows `node_modules/`, generated `dist/`, caches, browser profiles, session artifacts, logs and recordings from the ordinary source transfer.
- Exclude `.env` and every `.env.*` except `.env.example`, including `.env.backup-before-v5-fix`. Create Ubuntu's server-only configuration separately; never put the Gemini key into frontend configuration or documentation.
- Handle `data/` separately using the database procedure below. Retain only deliberately selected, sanitized historical evidence from `output/`.
- Record the copy date and hashes of source/lockfile. Keep the original Windows V5 usable.
- Use a supported current Node 22.x patch at **22.13.0 or later**, or another compatible version separately tested. The lockfile requires at least 22.12 for Vite; the application's unflagged `node:sqlite` import raises the unchanged-script floor to 22.13. [Node SQLite history](https://nodejs.org/api/sqlite.html).
- Install with `npm ci` using the preserved lockfile. Do not resolve the manifest's `latest` entries into a new dependency set during migration. [npm clean installation](https://docs.npmjs.com/cli/v11/commands/npm-ci/).
- Run `npm test` and `npm run build` in a clean test environment before adding real `.env` credentials. Tests load the server configuration and expect the test employee password; a local override can cause unrelated authentication failures.

Inspected lockfile versions: `@google/genai` 2.20.0, Express 5.2.1, Zod 4.5.4, concurrently 10.0.5, Vite 8.2.2 and Rolldown 1.2.6. Reinspect at transfer time if another V5 task has changed them.

### Database and network

- V5's database remains `data/actionguard-v5.db`, on the VM's own local disk. Use a fresh, clearly labelled Ubuntu demo database unless history is needed; preserve the original data independently.
- If transferring history, create a consistent SQLite backup snapshot, verify integrity and selected account/call/action counts, transfer it, and verify again. Keep the snapshot unchanged and run against a separate working copy.
- Do not copy just an actively used `.db`: V5 uses SQLite's WAL, a companion change log that can contain committed data. Independently copying changing database/WAL files is not a consistent backup. [SQLite backup API](https://www.sqlite.org/backup.html), [WAL requirements](https://www.sqlite.org/wal.html).
- Do not share one live database between Windows and Ubuntu. V5's database opener migrates and seeds; `npm run gate:report` calls it and is not a read-only inspection command.
- Keep V5's port separation: frontend **5175**, backend **4176**, browser session keys `v5_`. Sign in again; do not migrate browser session tokens.
- Development `npm run dev` exposes the frontend on all VM interfaces at 5175 and proxies `/api` to loopback 4176. Restrict reachability to the intended demo setup.
- Built mode is `npm run build`, then `npm start`; the server serves both the built page and API on **127.0.0.1:4176**. From another machine, use an intentional localhost forwarding connection or trusted HTTPS rather than assuming VM-IP access works.

Repository evidence inspected: `package.json`, `package-lock.json`, `vite.config.js`, `server/app.js`, `server/db.js`, `server/db-path-guard.js`, `scripts/gate-report.js`, `tests/port-guard.test.js`, `tests/api.test.js`, and `tests/delivery-style.test.js` in V5. These are source observations, not executed Ubuntu results.

## Phone-connector engineering boundaries

These requirements apply only after the phone-only test passes:

1. **Keep it removable.** Implement an independent V5 adapter/module and default-off configuration. Do not alter V1–V4 or substitute a new voice provider. No proposed adapter folder, setting or demo switch should be presented as already available.
2. **Translate the audio connection.** Asterisk's `chan_websocket` can provide bidirectional media; it is available from 20.16.0, 21.11.0, 22.6.0 and 23.0.0. Choose a maintained release containing the needed controls and verify the installed modules. Its audio protocol is different from Gemini's JSON messages, so a direct URL swap will not connect them. No extra SIP hop is required inside this proposed bridge. [Asterisk media driver](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/).
3. **Convert sound correctly.** Current `chan_mobile` uses narrowband audio. Gemini's standard Live audio uses 16-kHz input and 24-kHz output. Confirm the actual Asterisk format and use a proper continuous converter in both directions. V5's browser `resampleTo16k()` is a downsampler; feeding it 8-kHz phone audio would produce empty averaging bins and invalid upsampling. [Gemini audio formats](https://ai.google.dev/gemini-api/docs/live-api/capabilities), [mobile source](https://github.com/asterisk/asterisk/blob/22/addons/chan_mobile.c).
4. **Stop the full output path.** On a provider interruption, cancel pending adapter output and flush queued Asterisk media. Asterisk's `FLUSH_MEDIA` cannot retract audio already buffered in the handset/carrier. Measure remote audible stopping separately from local buffer events.
5. **Keep account authority on the server.** Bind the demo call to the intended sandbox account through an authenticated operator/server session. Caller ID alone is not authentication. Reuse existing tool policy and exactly-once execution; preserve the owner's decision to keep the current confirmation policy.
6. **Keep evidence honest.** The current browser's “played” counts are estimates even in the browser. Do not fabricate equivalent “caller heard it” values for telephony. Implement transport-specific evidence and report its limits; never turn missing evidence into a permission shortcut.
7. **Keep the agent's existing behavior.** Do not add a second verifier, keyword intent branches, a new denoiser or a new speech-to-text/text-to-speech pipeline as part of transport migration. Display-only transcript results remain outside tool authority.

Inspected V5 seams: `src/voice/gemini-live.js` currently owns browser capture, playback and interruption cleanup; `server/agent/gemini-live.js` issues browser credentials; `server/app.js` binds account/tool operations to authenticated sessions. The server does not currently carry telephone media.

## Evidence and next checkpoint

| Question | Current result |
| --- | --- |
| What was checked? | Current official carrier, VM, Bluetooth/telephony, Node, SQLite, browser and Gemini documentation; current V5 source and dependency lock; existing failure register. Research and migration inspection ran in parallel. |
| What happened? | A concrete local handset-to-Ubuntu candidate and a V5 copy checklist were identified. Direct forwarding to the website remains unsuitable. |
| What does it mean? | Test the physical call path first, then migrate and add the connector. The complete route is an **external candidate**, not verified locally. |
| What happens next? | Identify the actual demo computer, VM software and Bluetooth adapter; perform Steps 1–3. |

No Ubuntu installation, project migration, forwarding change, phone call, model inference or runtime-code change was performed for this plan. No new account or purchase was made.

For the first integrated rehearsal, use three short calls: an informational question; an interruption/correction with no unconfirmed action; and a separately confirmed billing-review intake producing exactly one record. Record the software versions, caller-heard behavior, disconnections and database outcome. Review the newest billing-team report before changing code. Passing these checks supports a small demo candidate; it does not replace V5's formal validation gate.

Existing evidence to retain:

- [Broad zero-spend route research](../research/ZERO_SPEND_PHONE_CALL_ROUTES_2026-09-04.md).
- [Failed and unresolved register](../research/FAILED_AND_UNRESOLVED_REGISTER.md): use the section **“Zero-spend personal-number telephone research — 2026-09-04”** when referring to its F67–F69 records; another section currently reuses F67/F68. F66 covers media transport. No historical result is promoted by this plan.
- [Hackathon scope guard](../VISION_AND_SCOPE_GUARD.md), [V5 build plan](../research/V5_BUILD_PLAN_NATURAL_VOICE_SMART_TRANSCRIPTS_2026-09-03.md), and [V5 freeze rules](docs/V5_ORIGIN_AND_FREEZE.md).
