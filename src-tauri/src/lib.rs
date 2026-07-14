//! Open-AdaptSound — Tauri backend
//! Safe Equalizer APO integration via dedicated include file + config merge.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const EQ_APO_CONFIG: &str = r"C:\Program Files\EqualizerAPO\config\config.txt";
const EQ_APO_CONFIG_X86: &str = r"C:\Program Files (x86)\EqualizerAPO\config\config.txt";
const EQ_APO_DIR: &str = r"C:\Program Files\EqualizerAPO";
const EQ_APO_DIR_X86: &str = r"C:\Program Files (x86)\EqualizerAPO";

/// Dedicated profile file name (included from config.txt — preserves other EQ).
const PROFILE_FILE_NAME: &str = "Open-AdaptSound.txt";
const INCLUDE_LINE: &str = "Include: Open-AdaptSound.txt";

const PROFILE_HEADER: &str = "# Open-AdaptSound Generated Profile";
const PROFILE_END: &str = "# End Open-AdaptSound Profile";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterObject {
    pub frequency: f64,
    pub gain_db: f64,
    pub q: f64,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub success: bool,
    pub path: String,
    pub profile_path: String,
    pub elevated: bool,
    pub message: String,
    pub config_preview: String,
    pub merged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApoStatus {
    pub installed: bool,
    pub config_path: Option<String>,
    pub profile_path: Option<String>,
    pub install_dir: Option<String>,
    pub can_write: bool,
    pub profile_active: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub name: String,
    pub modified: Option<String>,
}

// ─── System volume calibration (Windows Core Audio) ───────────────
//
// Samsung's Adapt Sound runs its test at a fixed media volume so thresholds
// are comparable regardless of where the user left the volume slider.
// We do the same: lock the default render endpoint to a reference level
// for the duration of the test, then restore the user's previous state.

/// Reference master-volume scalar used while the hearing test runs.
const CALIBRATION_VOLUME: f32 = 0.5;

struct TestSession {
    prev_volume: f32,
    prev_mute: bool,
    /// Profile text we temporarily replaced with a flat profile (so an
    /// already-applied EQ doesn't color the new test). Restored on end.
    suspended_profile: Option<(PathBuf, String)>,
}

static TEST_SESSION: Mutex<Option<TestSession>> = Mutex::new(None);

#[cfg(windows)]
mod sysvolume {
    use windows::core::Result;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    fn endpoint() -> Result<IAudioEndpointVolume> {
        unsafe {
            // Ignore RPC_E_CHANGED_MODE etc. — COM may already be initialized.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
        }
    }

    pub fn get() -> Result<(f32, bool)> {
        unsafe {
            let ep = endpoint()?;
            let vol = ep.GetMasterVolumeLevelScalar()?;
            let mute = ep.GetMute()?.as_bool();
            Ok((vol, mute))
        }
    }

    pub fn set(scalar: f32, mute: bool) -> Result<()> {
        unsafe {
            let ep = endpoint()?;
            ep.SetMasterVolumeLevelScalar(scalar.clamp(0.0, 1.0), std::ptr::null())?;
            ep.SetMute(mute, std::ptr::null())?;
            Ok(())
        }
    }
}

#[cfg(not(windows))]
mod sysvolume {
    pub fn get() -> Result<(f32, bool), String> {
        Err("not supported".into())
    }
    pub fn set(_scalar: f32, _mute: bool) -> Result<(), String> {
        Err("not supported".into())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSessionInfo {
    pub volume_locked: bool,
    pub calibration_volume: f32,
    pub previous_volume: Option<f32>,
    pub profile_suspended: bool,
    pub message: String,
}

// ─── Path resolution ───────────────────────────────────────────────

fn registry_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        // 64-bit and 32-bit registry views
        for path in [
            r"SOFTWARE\EqualizerAPO",
            r"SOFTWARE\WOW6432Node\EqualizerAPO",
        ] {
            if let Ok(key) = hklm.open_subkey(path) {
                if let Ok(config_path) = key.get_value::<String, _>("ConfigPath") {
                    let p = PathBuf::from(config_path.trim());
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Returns (install_dir, config.txt path, config directory).
fn resolve_apo_paths() -> (Option<PathBuf>, Option<PathBuf>, Option<PathBuf>) {
    if let Some(config_dir) = registry_config_dir() {
        let config = config_dir.join("config.txt");
        let install = config_dir
            .parent()
            .map(|p| p.to_path_buf())
            .filter(|p| p.exists());
        return (install, Some(config), Some(config_dir));
    }

    let candidates = [
        (PathBuf::from(EQ_APO_DIR), PathBuf::from(EQ_APO_CONFIG)),
        (PathBuf::from(EQ_APO_DIR_X86), PathBuf::from(EQ_APO_CONFIG_X86)),
    ];
    for (dir, config) in candidates {
        if dir.exists() {
            let config_dir = config.parent().map(|p| p.to_path_buf());
            return (Some(dir), Some(config), config_dir);
        }
    }
    for config in [PathBuf::from(EQ_APO_CONFIG), PathBuf::from(EQ_APO_CONFIG_X86)] {
        if config.exists() {
            let config_dir = config.parent().map(|p| p.to_path_buf());
            let install = config_dir
                .as_ref()
                .and_then(|d| d.parent())
                .map(|p| p.to_path_buf());
            return (install, Some(config), config_dir);
        }
    }
    (
        None,
        Some(PathBuf::from(EQ_APO_CONFIG)),
        Some(PathBuf::from(r"C:\Program Files\EqualizerAPO\config")),
    )
}

fn profile_path_from_config_dir(config_dir: &Path) -> PathBuf {
    config_dir.join(PROFILE_FILE_NAME)
}

fn user_data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("Open-AdaptSound")
}

fn user_fallback_path() -> PathBuf {
    user_data_dir().join("Open-AdaptSound.txt")
}

// ─── Config formatting ─────────────────────────────────────────────

/// Official Equalizer APO syntax using Channel: selection blocks.
pub fn format_eq_apo_config(filters: &[FilterObject], preamp_db: f64) -> String {
    let mut out = String::new();
    out.push_str(PROFILE_HEADER);
    out.push('\n');
    out.push_str("# Personalized hearing compensation — left/right parametric peaks\n");
    out.push_str("# Dynamic Headroom Reduction to Prevent Audio Distortion\n");
    out.push_str("# Included from config.txt — does not wipe other EQ settings\n");
    out.push_str(&format!("Preamp: {:.1} dB\n", preamp_db));
    // Reset channel selection to all before L/R blocks for predictable stacking
    out.push_str("Channel: all\n");
    out.push('\n');

    let left: Vec<&FilterObject> = filters
        .iter()
        .filter(|f| f.channel.eq_ignore_ascii_case("L") || f.channel.eq_ignore_ascii_case("left"))
        .collect();
    let right: Vec<&FilterObject> = filters
        .iter()
        .filter(|f| f.channel.eq_ignore_ascii_case("R") || f.channel.eq_ignore_ascii_case("right"))
        .collect();

    out.push_str("# Left Channel Calibrations\n");
    out.push_str("Channel: L\n");
    for f in &left {
        if f.gain_db.abs() < 0.05 {
            continue;
        }
        out.push_str(&format!(
            "Filter: ON PK Fc {:.0} Hz Gain {:.1} dB Q {:.2}\n",
            f.frequency, f.gain_db, f.q
        ));
    }
    out.push('\n');

    out.push_str("# Right Channel Calibrations\n");
    out.push_str("Channel: R\n");
    for f in &right {
        if f.gain_db.abs() < 0.05 {
            continue;
        }
        out.push_str(&format!(
            "Filter: ON PK Fc {:.0} Hz Gain {:.1} dB Q {:.2}\n",
            f.frequency, f.gain_db, f.q
        ));
    }
    out.push('\n');
    // Leave selection on all so any following includes are not stuck on R
    out.push_str("Channel: all\n");
    out.push_str(PROFILE_END);
    out.push('\n');
    out
}

fn flat_profile() -> String {
    format!(
        "{PROFILE_HEADER}\n# Profile reset — flat response\nPreamp: 0.0 dB\nChannel: all\n{PROFILE_END}\n"
    )
}

/// Merge Include line into existing config.txt without destroying user EQ.
pub fn merge_include_into_config(existing: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut in_legacy_block = false;
    let mut has_include = false;

    for line in existing.lines() {
        let trimmed = line.trim();

        // Drop legacy full-file Open-AdaptSound blocks that used to overwrite config.txt
        if trimmed.starts_with(PROFILE_HEADER) {
            in_legacy_block = true;
            continue;
        }
        if in_legacy_block {
            if trimmed.starts_with(PROFILE_END) {
                in_legacy_block = false;
            }
            continue;
        }

        // Normalize our include line (case-insensitive filename match)
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("include:") && lower.contains("open-adaptsound.txt") {
            if !has_include {
                lines.push(INCLUDE_LINE.to_string());
                has_include = true;
            }
            continue;
        }

        lines.push(line.to_string());
    }

    if !has_include {
        if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push("# Open-AdaptSound — personalized hearing profile (safe include)".into());
        lines.push(INCLUDE_LINE.to_string());
        lines.push(String::new());
    }

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Remove our Include line (used when fully disabling without leaving orphan include).
fn strip_include_from_config(existing: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in existing.lines() {
        let lower = line.trim().to_ascii_lowercase();
        if lower.starts_with("include:") && lower.contains("open-adaptsound.txt") {
            continue;
        }
        if line.trim() == "# Open-AdaptSound — personalized hearing profile (safe include)" {
            continue;
        }
        lines.push(line.to_string());
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

// ─── File I/O ──────────────────────────────────────────────────────

fn backup_existing_config(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let backup = path.with_file_name(format!("config.openadaptsound.bak.{stamp}.txt"));
    fs::copy(path, &backup).map_err(|e| format!("Failed to backup config: {e}"))?;
    Ok(Some(backup))
}

fn write_config_file(path: &Path, content: &str) -> Result<bool, String> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match try_direct_write(path, content) {
        Ok(()) => Ok(false),
        Err(e) if is_permission_error(&e) => {
            write_elevated(path, content)?;
            Ok(true)
        }
        Err(e) => Err(format!("Failed to write {}: {e}", path.display())),
    }
}

fn try_direct_write(path: &Path, content: &str) -> std::io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    Ok(())
}

fn is_permission_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Other
    ) || {
        #[cfg(windows)]
        {
            err.raw_os_error() == Some(5)
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
}

fn write_elevated(path: &Path, content: &str) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!(
        "open-adaptsound-{}",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("file.txt")
    ));
    fs::write(&temp_file, content).map_err(|e| format!("Failed to write temp config: {e}"))?;

    let script = temp_dir.join("open-adaptsound-elevate.ps1");
    let script_body = format!(
        r#"
$ErrorActionPreference = 'Stop'
$src = '{}'
$dst = '{}'
$dstDir = Split-Path -Parent $dst
if (-not (Test-Path $dstDir)) {{ New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }}
Copy-Item -LiteralPath $src -Destination $dst -Force
"#,
        temp_file.to_string_lossy().replace('\'', "''"),
        path.to_string_lossy().replace('\'', "''"),
    );
    fs::write(&script, script_body).map_err(|e| format!("Failed to write elevate script: {e}"))?;

    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!(
                "Start-Process -FilePath powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}' -Verb RunAs -Wait -WindowStyle Hidden",
                script.to_string_lossy().replace('\'', "''")
            ),
        ])
        .status()
        .map_err(|e| format!("Failed to launch elevated writer: {e}"))?;

    if !status.success() {
        return Err(
            "Elevated write was cancelled or failed. Approve the UAC prompt or run as Administrator."
                .into(),
        );
    }
    if !path.exists() {
        return Err("Elevated write finished but target file was not found.".into());
    }
    Ok(())
}

/// Write multiple files elevated in one UAC prompt when needed.
fn write_pair(config_path: &Path, config_text: &str, profile_path: &Path, profile_text: &str) -> Result<bool, String> {
    let mut elevated = false;
    match write_config_file(profile_path, profile_text) {
        Ok(e) => elevated |= e,
        Err(e) => return Err(e),
    }
    match write_config_file(config_path, config_text) {
        Ok(e) => elevated |= e,
        Err(e) => return Err(e),
    }
    Ok(elevated)
}

// ─── Commands ──────────────────────────────────────────────────────

/// Lock system volume to the calibration reference and suspend any active
/// EQ profile so the hearing test runs on a clean, repeatable output chain.
#[tauri::command]
fn begin_test_session() -> TestSessionInfo {
    // End any dangling session first (e.g. app reloaded mid-test).
    let _ = end_test_session_inner();

    let (volume_locked, previous_volume, prev_state) = match sysvolume::get() {
        Ok((vol, mute)) => match sysvolume::set(CALIBRATION_VOLUME, false) {
            Ok(()) => (true, Some(vol), Some((vol, mute))),
            Err(_) => (false, Some(vol), None),
        },
        Err(_) => (false, None, None),
    };

    // Temporarily flatten our profile (direct write only — never prompt UAC
    // just to start a test; most APO installs allow user writes here).
    let mut suspended_profile = None;
    let (_i, _config, config_dir) = resolve_apo_paths();
    if let Some(dir) = config_dir {
        let profile_path = profile_path_from_config_dir(&dir);
        if let Ok(text) = fs::read_to_string(&profile_path) {
            let is_active = text.contains(PROFILE_HEADER) && !text.contains("flat response");
            if is_active && try_direct_write(&profile_path, &flat_profile()).is_ok() {
                suspended_profile = Some((profile_path, text));
            }
        }
    }

    let profile_suspended = suspended_profile.is_some();
    if let Some((prev_volume, prev_mute)) = prev_state {
        *TEST_SESSION.lock().unwrap() = Some(TestSession {
            prev_volume,
            prev_mute,
            suspended_profile,
        });
    } else if let Some((path, text)) = suspended_profile {
        *TEST_SESSION.lock().unwrap() = Some(TestSession {
            prev_volume: CALIBRATION_VOLUME,
            prev_mute: false,
            suspended_profile: Some((path, text)),
        });
    }

    TestSessionInfo {
        volume_locked,
        calibration_volume: CALIBRATION_VOLUME,
        previous_volume,
        profile_suspended,
        message: if volume_locked {
            format!(
                "System volume locked to {:.0}% for calibration. It will be restored after the test.",
                CALIBRATION_VOLUME * 100.0
            )
        } else {
            "Could not lock system volume — keep your volume unchanged during the test.".into()
        },
    }
}

fn end_test_session_inner() -> bool {
    let session = TEST_SESSION.lock().unwrap().take();
    match session {
        Some(s) => {
            let _ = sysvolume::set(s.prev_volume, s.prev_mute);
            if let Some((path, text)) = s.suspended_profile {
                let _ = try_direct_write(&path, &text);
            }
            true
        }
        None => false,
    }
}

/// Restore volume/mute and any suspended EQ profile after the test.
#[tauri::command]
fn end_test_session() -> bool {
    end_test_session_inner()
}

#[tauri::command]
fn check_apo_status() -> ApoStatus {
    let (install_dir, config_path, config_dir) = resolve_apo_paths();
    let installed = install_dir.as_ref().map(|p| p.exists()).unwrap_or(false)
        || config_path.as_ref().map(|p| p.exists()).unwrap_or(false)
        || registry_config_dir().is_some();

    let profile_path = config_dir.as_ref().map(|d| profile_path_from_config_dir(d));

    let can_write = if let Some(ref dir) = config_dir {
        let probe = dir.join(".openadaptsound_write_probe");
        match fs::write(&probe, b"ok") {
            Ok(()) => {
                let _ = fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    } else {
        false
    };

    let profile_active = profile_path
        .as_ref()
        .map(|p| {
            p.exists()
                && fs::read_to_string(p)
                    .map(|t| t.contains(PROFILE_HEADER) && !t.contains("flat response"))
                    .unwrap_or(false)
        })
        .unwrap_or(false)
        || config_path
            .as_ref()
            .map(|p| {
                fs::read_to_string(p)
                    .map(|t| {
                        t.to_ascii_lowercase().contains("open-adaptsound.txt")
                            || t.contains(PROFILE_HEADER)
                    })
                    .unwrap_or(false)
            })
            .unwrap_or(false);

    let message = if !installed {
        "Equalizer APO was not found. Install it, then re-run Apply.".into()
    } else if can_write {
        "Equalizer APO detected. Ready to apply profile.".into()
    } else {
        "Equalizer APO detected. Admin permission will be requested when applying.".into()
    };

    ApoStatus {
        installed,
        config_path: config_path.map(|p| p.to_string_lossy().into_owned()),
        profile_path: profile_path.map(|p| p.to_string_lossy().into_owned()),
        install_dir: install_dir.map(|p| p.to_string_lossy().into_owned()),
        can_write,
        profile_active,
        message,
    }
}

#[tauri::command]
fn apply_adapt_sound_profile(
    filters: Vec<FilterObject>,
    preamp_db: f64,
) -> Result<ApplyResult, String> {
    if filters.is_empty() {
        return Err("No filters provided.".into());
    }

    let preamp_db = preamp_db.clamp(-24.0, 0.0);
    let profile_text = format_eq_apo_config(&filters, preamp_db);

    let (_install, config_path, config_dir) = resolve_apo_paths();
    let config_path =
        config_path.ok_or_else(|| "Could not resolve Equalizer APO config path.".to_string())?;
    let config_dir = config_dir
        .or_else(|| config_path.parent().map(|p| p.to_path_buf()))
        .ok_or_else(|| "Could not resolve Equalizer APO config directory.".to_string())?;
    let profile_path = profile_path_from_config_dir(&config_dir);

    let _ = backup_existing_config(&config_path);

    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    let merged_config = if existing.trim().is_empty() {
        format!(
            "# Equalizer APO config — managed include for Open-AdaptSound\n{INCLUDE_LINE}\n"
        )
    } else {
        merge_include_into_config(&existing)
    };

    // Also persist a local copy for re-apply / export
    let local = user_data_dir();
    let _ = fs::create_dir_all(&local);
    let _ = fs::write(local.join("last-profile.txt"), &profile_text);
    let _ = fs::write(
        local.join("last-profile.json"),
        serde_json::json!({
            "filters": filters,
            "preampDb": preamp_db,
            "appliedAt": chrono::Local::now().to_rfc3339(),
        })
        .to_string(),
    );

    match write_pair(&config_path, &merged_config, &profile_path, &profile_text) {
        Ok(elevated) => Ok(ApplyResult {
            success: true,
            path: config_path.to_string_lossy().into_owned(),
            profile_path: profile_path.to_string_lossy().into_owned(),
            elevated,
            merged: true,
            message: if elevated {
                "Profile applied with administrator privileges. Other EQ settings were preserved via Include.".into()
            } else {
                "Profile applied. Other Equalizer APO settings were preserved. Changes hot-reload instantly.".into()
            },
            config_preview: profile_text,
        }),
        Err(e) => {
            let fallback = user_fallback_path();
            let _ = fs::create_dir_all(user_data_dir());
            fs::write(&fallback, &profile_text)
                .map_err(|fe| format!("Primary write failed ({e}); fallback also failed: {fe}"))?;

            Ok(ApplyResult {
                success: false,
                path: fallback.to_string_lossy().into_owned(),
                profile_path: fallback.to_string_lossy().into_owned(),
                elevated: false,
                merged: false,
                message: format!(
                    "Could not write to Equalizer APO ({e}). Saved a copy to {}. \
                     Copy it into the APO config folder as Open-AdaptSound.txt and add: {INCLUDE_LINE}",
                    fallback.display()
                ),
                config_preview: profile_text,
            })
        }
    }
}

#[tauri::command]
fn reset_adapt_sound_profile() -> Result<ApplyResult, String> {
    let content = flat_profile();
    let (_install, config_path, config_dir) = resolve_apo_paths();
    let config_path =
        config_path.ok_or_else(|| "Could not resolve Equalizer APO config path.".to_string())?;
    let config_dir = config_dir
        .or_else(|| config_path.parent().map(|p| p.to_path_buf()))
        .ok_or_else(|| "Could not resolve Equalizer APO config directory.".to_string())?;
    let profile_path = profile_path_from_config_dir(&config_dir);

    let _ = backup_existing_config(&config_path);

    // Keep the Include line so future applies work; write flat profile
    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    let merged = if existing.trim().is_empty() {
        format!("{INCLUDE_LINE}\n")
    } else {
        merge_include_into_config(&existing)
    };

    match write_pair(&config_path, &merged, &profile_path, &content) {
        Ok(elevated) => Ok(ApplyResult {
            success: true,
            path: config_path.to_string_lossy().into_owned(),
            profile_path: profile_path.to_string_lossy().into_owned(),
            elevated,
            merged: true,
            message: "Adapt Sound profile reset to flat response. Other EQ settings kept.".into(),
            config_preview: content,
        }),
        Err(e) => Err(format!("Failed to reset profile: {e}")),
    }
}

#[tauri::command]
fn disable_adapt_sound_profile() -> Result<ApplyResult, String> {
    let (_install, config_path, config_dir) = resolve_apo_paths();
    let config_path =
        config_path.ok_or_else(|| "Could not resolve Equalizer APO config path.".to_string())?;
    let config_dir = config_dir
        .or_else(|| config_path.parent().map(|p| p.to_path_buf()))
        .ok_or_else(|| "Could not resolve Equalizer APO config directory.".to_string())?;
    let profile_path = profile_path_from_config_dir(&config_dir);

    let _ = backup_existing_config(&config_path);
    let existing = fs::read_to_string(&config_path).unwrap_or_default();
    let stripped = strip_include_from_config(&existing);
    let flat = flat_profile();

    match write_pair(&config_path, &stripped, &profile_path, &flat) {
        Ok(elevated) => Ok(ApplyResult {
            success: true,
            path: config_path.to_string_lossy().into_owned(),
            profile_path: profile_path.to_string_lossy().into_owned(),
            elevated,
            merged: true,
            message: "Open-AdaptSound include removed from config.txt. Profile disabled.".into(),
            config_preview: flat,
        }),
        Err(e) => Err(format!("Failed to disable profile: {e}")),
    }
}

#[tauri::command]
fn preview_config(filters: Vec<FilterObject>, preamp_db: f64) -> String {
    format_eq_apo_config(&filters, preamp_db.clamp(-24.0, 0.0))
}

#[tauri::command]
fn export_profile_text(filters: Vec<FilterObject>, preamp_db: f64) -> Result<String, String> {
    let text = format_eq_apo_config(&filters, preamp_db.clamp(-24.0, 0.0));
    let dir = user_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("Open-AdaptSound.txt");
    fs::write(&path, &text).map_err(|e| e.to_string())?;
    // Also stamp a versioned export
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let versioned = dir.join(format!("export-{stamp}.txt"));
    let _ = fs::write(&versioned, &text);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_config_backups() -> Result<Vec<BackupInfo>, String> {
    let (_i, config_path, _) = resolve_apo_paths();
    let config_path = match config_path {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    let dir = match config_path.parent() {
        Some(d) => d.to_path_buf(),
        None => return Ok(vec![]),
    };

    let mut backups = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(vec![]),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("config.openadaptsound.bak.") && name.ends_with(".txt") {
            let modified = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.to_rfc3339()
                });
            backups.push(BackupInfo {
                path: entry.path().to_string_lossy().into_owned(),
                name,
                modified,
            });
        }
    }
    backups.sort_by(|a, b| b.name.cmp(&a.name));
    backups.truncate(20);
    Ok(backups)
}

#[tauri::command]
fn restore_config_backup(backup_path: String) -> Result<ApplyResult, String> {
    let path = PathBuf::from(&backup_path);
    if !path.exists() {
        return Err("Backup file not found.".into());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (_i, config_path, _) = resolve_apo_paths();
    let config_path =
        config_path.ok_or_else(|| "Could not resolve Equalizer APO config path.".to_string())?;

    let _ = backup_existing_config(&config_path);
    match write_config_file(&config_path, &content) {
        Ok(elevated) => Ok(ApplyResult {
            success: true,
            path: config_path.to_string_lossy().into_owned(),
            profile_path: path.to_string_lossy().into_owned(),
            elevated,
            merged: false,
            message: format!("Restored backup: {}", path.file_name().unwrap_or_default().to_string_lossy()),
            config_preview: content.chars().take(800).collect(),
        }),
        Err(e) => Err(e),
    }
}

#[tauri::command]
fn get_last_applied_preview() -> Option<String> {
    let p = user_data_dir().join("last-profile.txt");
    fs::read_to_string(p).ok()
}

/// Official Equalizer APO download (SourceForge project files — latest).
/// We intentionally do NOT bundle the APO installer inside our EXE:
/// - Device Selector must run interactively (pick headphones)
/// - Windows typically requires a reboot after APO is attached to a device
/// - Silent /S still leaves Device Selector manual; embedding is fragile
const EQ_APO_DOWNLOAD_URL: &str =
    "https://sourceforge.net/projects/equalizerapo/files/latest/download";
const EQ_APO_HOME_URL: &str = "https://equalizerapo.com/";

#[tauri::command]
fn open_equalizer_apo_download(app: tauri::AppHandle) -> Result<(), String> {
    // Prefer direct latest package; home page as fallback path for users
    if app
        .opener()
        .open_url(EQ_APO_DOWNLOAD_URL, None::<&str>)
        .is_err()
    {
        app.opener()
            .open_url(EQ_APO_HOME_URL, None::<&str>)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_config_folder(app: tauri::AppHandle) -> Result<(), String> {
    let (_i, config_path, config_dir) = resolve_apo_paths();
    let dir = config_dir
        .or_else(|| config_path.and_then(|p| p.parent().map(|d| d.to_path_buf())))
        .ok_or_else(|| "Config folder not found.".to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ─── App entry ─────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            begin_test_session,
            end_test_session,
            check_apo_status,
            apply_adapt_sound_profile,
            reset_adapt_sound_profile,
            disable_adapt_sound_profile,
            preview_config,
            export_profile_text,
            list_config_backups,
            restore_config_backup,
            get_last_applied_preview,
            open_equalizer_apo_download,
            open_config_folder,
        ])
        .setup(|app| {
            let show_i =
                MenuItem::with_id(app, "show", "Show Open-AdaptSound", true, None::<&str>)?;
            let status_i =
                MenuItem::with_id(app, "status", "Check Equalizer APO…", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &status_i, &sep, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Open-AdaptSound")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" | "status" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        // Never leave the user's volume stuck at the calibration level
                        end_test_session_inner();
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_channel_blocks_correctly() {
        let filters = vec![
            FilterObject {
                frequency: 1000.0,
                gain_db: 3.0,
                q: 1.41,
                channel: "L".into(),
            },
            FilterObject {
                frequency: 4000.0,
                gain_db: 6.5,
                q: 1.41,
                channel: "R".into(),
            },
        ];
        let text = format_eq_apo_config(&filters, -6.5);
        assert!(text.contains("Preamp: -6.5 dB"));
        assert!(text.contains("Channel: L"));
        assert!(text.contains("Channel: R"));
        assert!(text.contains("Filter: ON PK Fc 1000 Hz Gain 3.0 dB Q 1.41"));
        assert!(text.contains("Filter: ON PK Fc 4000 Hz Gain 6.5 dB Q 1.41"));
        assert!(!text.contains("Q 1.41 Channel:"));
        assert!(text.contains("Channel: all"));
    }

    #[test]
    fn skips_near_zero_gains() {
        let filters = vec![FilterObject {
            frequency: 250.0,
            gain_db: 0.0,
            q: 1.41,
            channel: "L".into(),
        }];
        let text = format_eq_apo_config(&filters, 0.0);
        assert!(!text.contains("Fc 250"));
    }

    #[test]
    fn merge_include_preserves_user_lines() {
        let existing = "\
Preamp: -2 dB
Filter: ON PK Fc 80 Hz Gain 2.0 dB Q 1.0
Include: something-else.txt
";
        let merged = merge_include_into_config(existing);
        assert!(merged.contains("Filter: ON PK Fc 80 Hz"));
        assert!(merged.contains("Include: something-else.txt"));
        assert!(merged.contains(INCLUDE_LINE));
        assert_eq!(merged.matches(INCLUDE_LINE).count(), 1);
    }

    #[test]
    fn merge_strips_legacy_full_profile_block() {
        let existing = format!(
            "Device: Speakers\n{PROFILE_HEADER}\nPreamp: -3 dB\nChannel: L\n{PROFILE_END}\nPreamp: -1 dB\n"
        );
        let merged = merge_include_into_config(&existing);
        assert!(merged.contains("Device: Speakers"));
        assert!(merged.contains("Preamp: -1 dB"));
        assert!(!merged.contains("Channel: L"));
        assert!(merged.contains(INCLUDE_LINE));
    }

    #[test]
    fn strip_include_removes_only_ours() {
        let existing = format!("A\n{INCLUDE_LINE}\nB\nInclude: other.txt\n");
        let stripped = strip_include_from_config(&existing);
        assert!(stripped.contains("Include: other.txt"));
        assert!(!stripped.to_ascii_lowercase().contains("open-adaptsound"));
        assert!(stripped.contains('A'));
        assert!(stripped.contains('B'));
    }
}
