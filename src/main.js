/**
 * Open-AdaptSound — Samsung-style Yes/No hearing wizard
 * Beeps play continuously; adaptive staircase finds each threshold.
 */

import { ToneEngine, checkAmbientNoise } from "./audio-engine.js";
import {
  FREQUENCIES,
  buildProfile,
  describeProfile,
  profileToInvokePayload,
  hlToPresentationDbfs,
  dbToGain,
  BASELINE_HL,
  MODES,
} from "./calculator.js";
import { loadSettings, saveSettings } from "./settings.js";
import { createStaircase, answerStaircase } from "./staircase.js";

const STEPS = 5;
// v2: thresholds stored in dB HL (v1 stored linear gain — incompatible)
const STORAGE_KEY = "open-adaptsound-last-profile-v2";

const invoke =
  window.__TAURI__?.core?.invoke ??
  (async (cmd, args) => {
    console.warn("Tauri invoke unavailable (browser preview):", cmd, args);
    if (cmd === "check_apo_status") {
      return {
        installed: false,
        configPath: null,
        canWrite: false,
        profileActive: false,
        message: "Preview mode — Tauri backend not connected.",
      };
    }
    if (cmd === "begin_test_session") {
      return {
        volumeLocked: false,
        calibrationVolume: 0.5,
        previousVolume: null,
        profileSuspended: false,
        message: "Preview mode — set your volume to ~50% manually.",
      };
    }
    if (cmd === "end_test_session") return false;
    if (cmd === "preview_config") return "# preview mode\n";
    if (cmd === "list_config_backups") return [];
    if (cmd === "get_last_applied_preview") return null;
    return {
      success: false,
      path: "",
      profilePath: "",
      elevated: false,
      merged: false,
      message: "Not running inside Tauri. Use npm run dev.",
      configPreview: "",
    };
  });

const state = {
  step: 0,
  prevStep: 0,
  leftIndex: 0,
  rightIndex: 0,
  left: {},
  right: {},
  profile: null,
  apo: null,
  settings: loadSettings(),
  hasSavedProfile: false,
  /** Active staircase for current frequency */
  stair: null,
  /** Debounce double-taps during level change */
  answering: false,
  /** Volume-calibration session active (system volume locked) */
  calibrated: false,
};

const engine = new ToneEngine();
const $ = (sel) => document.querySelector(sel);

/** Hearing test is always Samsung-style repeating beeps. */
function toneMode() {
  return "beep";
}

function renderProgress() {
  const root = $("#progress");
  root.innerHTML = "";
  if (state.step === "settings" || state.step === "setup") return;
  for (let i = 0; i < STEPS; i++) {
    const d = document.createElement("div");
    d.className = "progress-dot";
    if (i < state.step) d.classList.add("done");
    if (i === state.step) d.classList.add("active");
    root.appendChild(d);
  }
}

function showStep(n) {
  if (n !== "settings" && n !== "setup") state.step = n;
  else state.step = n;
  document.querySelectorAll(".step").forEach((el) => {
    const key = el.dataset.step;
    let active = false;
    if (n === "settings" || n === "setup") {
      active = key === n;
    } else {
      active = Number(key) === n && key !== "settings" && key !== "setup";
    }
    el.classList.toggle("active", active);
  });
  renderProgress();
}

async function openApoDownload() {
  try {
    await invoke("open_equalizer_apo_download");
  } catch {
    window.open("https://sourceforge.net/projects/equalizerapo/files/latest/download", "_blank");
  }
}

function openSettings() {
  state.prevStep = state.step;
  // Pause beeps while the overlay is open — they used to keep playing here
  if (state.prevStep === 2 || state.prevStep === 3) engine.stop();
  const s = state.settings;
  $("#set-mode").value = s.mode || "half";
  refreshApoChip();
  const chip = state.apo;
  $("#settings-apo-text").textContent = chip
    ? chip.message + (chip.configPath ? `\n${chip.configPath}` : "")
    : "Status unknown.";
  showStep("settings");
}

function closeSettings() {
  state.settings = saveSettings({
    mode: $("#set-mode").value,
    toneMode: "beep",
  });
  engine.setToneMode("beep");
  const back = state.prevStep ?? 0;
  if (back === 4 && Object.keys(state.left).length) {
    rebuildProfileFromThresholds();
  }
  showStep(back);
  // Resume the interrupted band (fresh staircase for a clean measurement)
  if (back === 2) startEarBand("L");
  else if (back === 3) startEarBand("R");
}

/* ─── Volume calibration session ─── */
async function beginCalibration() {
  if (state.calibrated) return;
  try {
    const info = await invoke("begin_test_session");
    state.calibrated = true;
    const note = info?.message || "";
    const el1 = $("#left-cal-note");
    const el2 = $("#right-cal-note");
    if (el1) el1.textContent = note;
    if (el2) el2.textContent = note;
  } catch (err) {
    console.warn("begin_test_session failed", err);
  }
}

async function endCalibration() {
  if (!state.calibrated) return;
  state.calibrated = false;
  try {
    await invoke("end_test_session");
  } catch (err) {
    console.warn("end_test_session failed", err);
  }
}

function initThresholds() {
  for (const f of FREQUENCIES) {
    state.left[f] = null;
    state.right[f] = null;
  }
}

function bandWidth(index) {
  return `${Math.round(((index + 1) / FREQUENCIES.length) * 100)}%`;
}

/* ─── APO status ─── */
async function refreshApoChip() {
  const chip = $("#apo-chip");
  try {
    state.apo = await invoke("check_apo_status");
  } catch {
    state.apo = null;
  }
  if (!chip) return;
  chip.classList.remove("ok", "warn", "err");
  const startBtn = $("#btn-start");
  const anyway = $("#btn-start-anyway");
  const installBtn = $("#btn-install-apo");

  if (!state.apo) {
    chip.textContent = "Could not check Equalizer APO status.";
    chip.classList.add("warn");
    anyway?.classList.remove("hidden");
    installBtn?.classList.remove("hidden");
    return;
  }
  if (!state.apo.installed) {
    chip.textContent = "Equalizer APO not found — needed for system-wide sound.";
    chip.classList.add("err");
    if (startBtn) startBtn.textContent = "Set up Equalizer APO";
    anyway?.classList.remove("hidden");
    installBtn?.classList.remove("hidden");
  } else if (state.apo.profileActive) {
    chip.textContent = "Equalizer APO ready · Adapt Sound profile is active.";
    chip.classList.add("ok");
    if (startBtn) startBtn.textContent = "Start listening check";
    anyway?.classList.add("hidden");
    installBtn?.classList.add("hidden");
  } else {
    chip.textContent = "Equalizer APO ready.";
    chip.classList.add("ok");
    if (startBtn) startBtn.textContent = "Start listening check";
    anyway?.classList.add("hidden");
    installBtn?.classList.add("hidden");
  }
}

function loadSavedProfileFlag() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state.hasSavedProfile = !!raw;
    if (raw) $("#btn-reapply")?.classList.remove("hidden");
  } catch {
    state.hasSavedProfile = false;
  }
}

/* ─── Welcome ─── */
async function onStart() {
  await refreshApoChip();
  // If APO missing, send user to setup instead of silent failure later
  if (state.apo && !state.apo.installed) {
    showStep("setup");
    return;
  }
  beginWizard();
}

function beginWizard() {
  initThresholds();
  state.leftIndex = 0;
  state.rightIndex = 0;
  state.stair = null;
  engine.setToneMode(toneMode());
  showStep(1);
}

/* ─── Noise ─── */
async function onNoiseCheck() {
  const btn = $("#btn-noise-check");
  const status = $("#noise-status");
  const panel = $("#noise-panel");
  const meter = $("#noise-meter");
  const cont = $("#btn-noise-continue");

  btn.disabled = true;
  status.innerHTML = 'Listening to the room<span class="loading-dots"></span>';
  meter.style.width = "15%";
  panel.classList.remove("warn");

  const result = await checkAmbientNoise(1400);
  const levelPct =
    result.level == null ? 40 : Math.min(100, Math.round(result.level * 2500));
  meter.style.width = `${Math.max(8, levelPct)}%`;
  status.textContent = result.message;
  panel.classList.toggle("warn", result.ok === false);

  cont.classList.remove("hidden");
  btn.disabled = false;
  btn.textContent = "Check again";
}

async function continueFromNoise() {
  showStep(2);
  await beginCalibration();
  startEarBand("L");
}

/* ─── Ear tests: continuous beeps + Yes/No staircase ─── */

function setAnswerButtonsEnabled(ear, enabled) {
  const isLeft = ear === "L";
  const yes = $(isLeft ? "#btn-left-yes" : "#btn-right-yes");
  const no = $(isLeft ? "#btn-left-no" : "#btn-right-no");
  if (yes) yes.disabled = !enabled;
  if (no) no.disabled = !enabled;
}

function updateEarChrome(ear) {
  const isLeft = ear === "L";
  const idx = isLeft ? state.leftIndex : state.rightIndex;
  const label = $(isLeft ? "#left-freq-label" : "#right-freq-label");
  const band = $(isLeft ? "#left-band" : "#right-band");
  const hint = $(isLeft ? "#left-hint" : "#right-hint");
  const visual = $(isLeft ? "#left-visual" : "#right-visual");

  label.textContent = `Sound ${idx + 1} of ${FREQUENCIES.length}`;
  band.style.width = bandWidth(idx);
  visual.classList.add("playing", "pulse-mode");

  if (state.stair && !state.stair.done && state.stair.trials === 0) {
    hint.textContent = "Listen… beeps are playing now";
  }
}

async function startEarBand(ear) {
  const isLeft = ear === "L";
  const idx = isLeft ? state.leftIndex : state.rightIndex;
  const freq = FREQUENCIES[idx];

  state.stair = createStaircase();
  state.answering = false;
  setAnswerButtonsEnabled(ear, true);
  updateEarChrome(ear);

  await engine.play(freq, ear, presentationGain(freq, state.stair.level), {
    mode: toneMode(),
  });
}

/** dB HL staircase level → linear Web Audio gain for this band. */
function presentationGain(freq, levelHl) {
  return dbToGain(hlToPresentationDbfs(freq, levelHl));
}

/**
 * User answered Yes (heard) or No (not heard).
 * Staircase adjusts level automatically; when done, stores threshold & advances.
 */
async function onHearAnswer(ear, heard) {
  if (state.answering || !state.stair || state.stair.done) return;
  state.answering = true;
  setAnswerButtonsEnabled(ear, false);

  const isLeft = ear === "L";
  const idx = isLeft ? state.leftIndex : state.rightIndex;
  const freq = FREQUENCIES[idx];
  const hint = $(isLeft ? "#left-hint" : "#right-hint");

  const result = answerStaircase(state.stair, heard);

  if (result.done) {
    const thr = result.threshold ?? state.stair.level;
    if (isLeft) state.left[freq] = thr;
    else state.right[freq] = thr;

    hint.textContent = "Got it — next sound…";
    // Brief pause so level change / frequency jump isn't jarring
    await sleep(220);
    await advanceAfterBand(ear);
    state.answering = false;
    return;
  }

  // Keep same frequency, new level — beeps keep playing
  const gain = presentationGain(freq, result.level);
  engine.setVolume(gain);
  if (!engine.playing) {
    await engine.play(freq, ear, gain, { mode: toneMode() });
  }

  hint.textContent = heard
    ? "Playing softer… can you still hear it?"
    : "Playing louder… can you hear it now?";

  updateEarChrome(ear);
  await sleep(180);
  setAnswerButtonsEnabled(ear, true);
  state.answering = false;
}

async function advanceAfterBand(ear) {
  const isLeft = ear === "L";
  const idx = isLeft ? state.leftIndex : state.rightIndex;

  if (idx + 1 < FREQUENCIES.length) {
    if (isLeft) state.leftIndex += 1;
    else state.rightIndex += 1;
    await startEarBand(ear);
    return;
  }

  // Finished this ear
  engine.stop();
  $(isLeft ? "#left-visual" : "#right-visual")?.classList.remove("playing");

  if (isLeft) {
    showStep(3);
    state.rightIndex = 0;
    await startEarBand("R");
  } else {
    // Test finished — restore the user's volume & any suspended profile
    await endCalibration();
    // Fill any nulls with baseline (shouldn't happen)
    for (const f of FREQUENCIES) {
      if (state.left[f] == null) state.left[f] = BASELINE_HL;
      if (state.right[f] == null) state.right[f] = BASELINE_HL;
    }
    finalizeProfile();
    showStep(4);
  }
}

async function onEarBack(ear) {
  if (state.answering) return;
  const isLeft = ear === "L";
  const idx = isLeft ? state.leftIndex : state.rightIndex;

  if (idx > 0) {
    if (isLeft) {
      state.leftIndex -= 1;
      const f = FREQUENCIES[state.leftIndex];
      state.left[f] = null;
    } else {
      state.rightIndex -= 1;
      const f = FREQUENCIES[state.rightIndex];
      state.right[f] = null;
    }
    await startEarBand(ear);
    return;
  }

  engine.stop();
  if (isLeft) {
    await endCalibration();
    showStep(1);
  } else {
    showStep(2);
    state.leftIndex = FREQUENCIES.length - 1;
    state.left[FREQUENCIES[state.leftIndex]] = null;
    await startEarBand("L");
  }
}

function rebuildProfileFromThresholds() {
  const mode = state.settings.mode || "half";
  // Coerce any nulls
  const left = {};
  const right = {};
  for (const f of FREQUENCIES) {
    left[f] = state.left[f] ?? BASELINE_HL;
    right[f] = state.right[f] ?? BASELINE_HL;
  }
  state.profile = buildProfile(left, right, { mode });
  $("#apply-summary").textContent = describeProfile(state.profile);
  syncModeSeg(mode);
  return state.profile;
}

function finalizeProfile() {
  rebuildProfileFromThresholds();
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        left: state.left,
        right: state.right,
        profile: state.profile,
        settings: state.settings,
        at: new Date().toISOString(),
      })
    );
    state.hasSavedProfile = true;
  } catch {
    /* ignore */
  }

  $("#apply-icon").textContent = "✨";
  $("#apply-title").textContent = "Your profile is ready";
  $("#apply-lead").textContent =
    "Apply locks this in system-wide. Other Equalizer APO settings stay intact.";
  $("#apply-meta").classList.add("hidden");
  $("#mode-row").classList.remove("hidden");
  $("#btn-apply").classList.remove("hidden");
  $("#btn-apply").disabled = false;
  $("#btn-apply").textContent = "Apply Adapt Sound Profile";
  $("#btn-retake").classList.add("hidden");
  $("#btn-reset").classList.add("hidden");
  $("#btn-export").classList.add("hidden");
  $("#btn-open-config").classList.add("hidden");
  $("#btn-disable").classList.add("hidden");

  if (state.apo && !state.apo.installed) {
    $("#apply-lead").textContent =
      "Equalizer APO was not detected. Save the profile, install APO, then apply again.";
  }
}

function syncModeSeg(mode) {
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}

function onModeChange(mode) {
  state.settings = saveSettings({ mode });
  if (state.left && Object.keys(state.left).length) {
    rebuildProfileFromThresholds();
  }
}

/* ─── Apply ─── */
async function onApply() {
  if (!state.profile) finalizeProfile();
  const btn = $("#btn-apply");
  const meta = $("#apply-meta");
  btn.disabled = true;
  btn.innerHTML = 'Applying<span class="loading-dots"></span>';

  const payload = profileToInvokePayload(state.profile);

  try {
    const result = await invoke("apply_adapt_sound_profile", payload);
    meta.classList.remove("hidden");

    if (result.success) {
      $("#apply-icon").textContent = "✓";
      $("#apply-title").textContent = "Adapt Sound is on";
      $("#apply-lead").textContent =
        "Your personalized profile is active system-wide. Play music or a video — it should already sound clearer.";
      meta.textContent = [
        result.message,
        `Config: ${result.path}`,
        result.profilePath ? `Profile: ${result.profilePath}` : "",
        `Max boost: ${state.profile.maxBoost} dB · Preamp: ${state.profile.preampDb} dB · Mode: ${MODES[state.profile.mode]?.label || state.profile.mode}`,
        result.merged ? "Other EQ settings preserved via Include." : "",
      ]
        .filter(Boolean)
        .join("\n");
      btn.classList.add("hidden");
      $("#mode-row").classList.add("hidden");
    } else {
      $("#apply-icon").textContent = "!";
      $("#apply-title").textContent = "Almost there";
      $("#apply-lead").textContent = result.message;
      meta.textContent = result.configPreview || "";
      btn.disabled = false;
      btn.textContent = "Try Apply again";
    }

    $("#btn-retake").classList.remove("hidden");
    $("#btn-reset").classList.remove("hidden");
    $("#btn-export").classList.remove("hidden");
    $("#btn-open-config").classList.remove("hidden");
    $("#btn-disable").classList.remove("hidden");
    await refreshApoChip();
  } catch (err) {
    meta.classList.remove("hidden");
    meta.textContent = String(err);
    $("#apply-icon").textContent = "!";
    $("#apply-title").textContent = "Could not apply";
    $("#apply-lead").textContent =
      "Writing to Equalizer APO failed. Approve the admin prompt or install Equalizer APO.";
    btn.disabled = false;
    btn.textContent = "Try again";
    $("#btn-retake").classList.remove("hidden");
    $("#btn-export").classList.remove("hidden");
  }
}

async function onReset() {
  const btn = $("#btn-reset");
  btn.disabled = true;
  try {
    const result = await invoke("reset_adapt_sound_profile");
    $("#apply-meta").classList.remove("hidden");
    $("#apply-meta").textContent = `${result.message}\n${result.path || ""}`;
    $("#apply-icon").textContent = "○";
    $("#apply-title").textContent = "Profile reset";
    $("#apply-lead").textContent = "Sound is back to a flat (unboosted) Adapt Sound layer.";
    await refreshApoChip();
  } catch (err) {
    $("#apply-meta").classList.remove("hidden");
    $("#apply-meta").textContent = String(err);
  } finally {
    btn.disabled = false;
  }
}

async function onDisable() {
  try {
    const result = await invoke("disable_adapt_sound_profile");
    $("#apply-meta").classList.remove("hidden");
    $("#apply-meta").textContent = result.message;
    $("#apply-icon").textContent = "○";
    $("#apply-title").textContent = "Adapt Sound disabled";
    $("#apply-lead").textContent = "The include line was removed from config.txt.";
    await refreshApoChip();
  } catch (err) {
    $("#apply-meta").classList.remove("hidden");
    $("#apply-meta").textContent = String(err);
  }
}

async function onExport() {
  if (!state.profile) return;
  const payload = profileToInvokePayload(state.profile);
  try {
    const path = await invoke("export_profile_text", payload);
    $("#apply-meta").classList.remove("hidden");
    $("#apply-meta").textContent = `Profile saved to:\n${path}`;
  } catch {
    downloadText("open-adaptsound-profile.txt", formatLocalPreview(state.profile));
    $("#apply-meta").classList.remove("hidden");
    $("#apply-meta").textContent = "Downloaded open-adaptsound-profile.txt";
  }
}

function formatLocalPreview(profile) {
  const lines = [
    "# Open-AdaptSound Generated Profile",
    `Preamp: ${profile.preampDb.toFixed(1)} dB`,
    "Channel: all",
    "",
    "Channel: L",
  ];
  for (const f of profile.filters.filter((x) => x.channel === "L" && x.gainDb >= 0.05)) {
    lines.push(
      `Filter: ON PK Fc ${f.frequency} Hz Gain ${f.gainDb.toFixed(1)} dB Q ${f.q.toFixed(2)}`
    );
  }
  lines.push("", "Channel: R");
  for (const f of profile.filters.filter((x) => x.channel === "R" && x.gainDb >= 0.05)) {
    lines.push(
      `Filter: ON PK Fc ${f.frequency} Hz Gain ${f.gainDb.toFixed(1)} dB Q ${f.q.toFixed(2)}`
    );
  }
  lines.push("Channel: all", "");
  return lines.join("\n");
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function onRetake() {
  engine.stop();
  endCalibration();
  initThresholds();
  state.leftIndex = 0;
  state.rightIndex = 0;
  state.profile = null;
  state.stair = null;
  showStep(0);
}

async function onReapply() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.left = data.left || {};
    state.right = data.right || {};
    if (data.settings) {
      state.settings = saveSettings(data.settings);
    }
    finalizeProfile();
    showStep(4);
  } catch (err) {
    console.warn(err);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ─── Wire UI ─── */
function wire() {
  state.settings = loadSettings();
  engine.setToneMode(toneMode());
  renderProgress();
  loadSavedProfileFlag();
  refreshApoChip();

  $("#btn-start").addEventListener("click", onStart);
  $("#btn-reapply")?.addEventListener("click", onReapply);
  $("#btn-install-apo")?.addEventListener("click", () => showStep("setup"));
  $("#btn-apo-help")?.addEventListener("click", () => showStep("setup"));
  $("#btn-start-anyway")?.addEventListener("click", beginWizard);
  $("#btn-setup-download")?.addEventListener("click", openApoDownload);
  $("#btn-setup-recheck")?.addEventListener("click", async () => {
    await refreshApoChip();
    if (state.apo?.installed) {
      showStep(0);
    } else {
      alert(
        "Equalizer APO still not detected.\n\n" +
          "1) Finish the APO installer\n" +
          "2) Enable your headphones in Device Selector\n" +
          "3) Reboot Windows\n" +
          "4) Open Open-AdaptSound again and press Recheck"
      );
    }
  });
  $("#btn-setup-back")?.addEventListener("click", () => showStep(0));

  $("#btn-noise-check").addEventListener("click", onNoiseCheck);
  $("#btn-noise-continue").addEventListener("click", continueFromNoise);
  $("#btn-noise-skip").addEventListener("click", continueFromNoise);
  $("#btn-noise-back").addEventListener("click", () => {
    engine.stop();
    showStep(0);
  });

  $("#btn-left-yes").addEventListener("click", () => onHearAnswer("L", true));
  $("#btn-left-no").addEventListener("click", () => onHearAnswer("L", false));
  $("#btn-right-yes").addEventListener("click", () => onHearAnswer("R", true));
  $("#btn-right-no").addEventListener("click", () => onHearAnswer("R", false));
  $("#btn-left-back").addEventListener("click", () => onEarBack("L"));
  $("#btn-right-back").addEventListener("click", () => onEarBack("R"));

  $("#btn-apply").addEventListener("click", onApply);
  $("#btn-retake").addEventListener("click", onRetake);
  $("#btn-reset").addEventListener("click", onReset);
  $("#btn-export").addEventListener("click", onExport);
  $("#btn-disable").addEventListener("click", onDisable);
  $("#btn-open-config").addEventListener("click", () =>
    invoke("open_config_folder").catch(console.warn)
  );

  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => onModeChange(b.dataset.mode));
  });

  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-settings-done").addEventListener("click", closeSettings);
  $("#btn-settings-apo").addEventListener("click", () =>
    invoke("open_equalizer_apo_download").catch(() =>
      window.open("https://equalizerapo.com/", "_blank")
    )
  );
  $("#btn-settings-folder").addEventListener("click", () =>
    invoke("open_config_folder").catch(console.warn)
  );

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (state.step === 2 || state.step === 3)) {
      engine.stop();
      $("#left-visual")?.classList.remove("playing");
      $("#right-visual")?.classList.remove("playing");
    } else if (!document.hidden && state.step === 2) {
      startEarBand("L");
    } else if (!document.hidden && state.step === 3) {
      startEarBand("R");
    }
  });

  window.addEventListener("beforeunload", () => {
    engine.stop();
    // Best effort: never leave system volume stuck at calibration level
    if (state.calibrated) invoke("end_test_session").catch(() => {});
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.querySelector("#step-settings.active")) {
      closeSettings();
      return;
    }

    // Y / N during ear test (Samsung remote-style)
    if (state.step === 2 || state.step === 3) {
      const ear = state.step === 2 ? "L" : "R";
      if (e.key === "y" || e.key === "Y" || e.key === "1") {
        e.preventDefault();
        onHearAnswer(ear, true);
        return;
      }
      if (e.key === "n" || e.key === "N" || e.key === "2" || e.key === "0") {
        e.preventDefault();
        onHearAnswer(ear, false);
        return;
      }
    }

    if (e.key !== "Enter") return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "TEXTAREA" || tag === "SELECT") return;
    if (state.step === "settings" || document.querySelector("#step-settings.active")) return;
    if (state.step === 0) $("#btn-start").click();
    else if (state.step === 1) {
      const cont = $("#btn-noise-continue");
      if (!cont.classList.contains("hidden")) cont.click();
      else $("#btn-noise-check").click();
    } else if (state.step === 4) {
      const apply = $("#btn-apply");
      if (!apply.classList.contains("hidden") && !apply.disabled) apply.click();
    }
  });
}

window.addEventListener("DOMContentLoaded", wire);

window.__OpenAdaptSound = {
  state,
  FREQUENCIES,
  BASELINE_HL,
  MODES,
  buildProfile,
  describeProfile,
  engine,
};
