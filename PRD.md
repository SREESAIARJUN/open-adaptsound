## Product Requirement Document (PRD): Custom Windows Adapt Sound Clone
Project Name: Open-AdaptSound
Target Platform: Windows 11 (64-bit)
Tech Stack: Tauri, HTML5 Web Audio API, Rust, Equalizer APO Driver
------------------------------
## 1. Product Overview & Core Philosophy
The purpose of this application is to recreate the seamless, 3-step user experience of Samsung’s Adapt Sound for Windows 11. It completely replaces the complex, confusing, and cluttered user interfaces of traditional equalizer apps with a minimalist listening wizard.
The application serves purely as a frontend configuration orchestrator. It uses the browser-native Web Audio API to run a local hearing diagnostic test, calculates a personalized frequency compensation profile, and directly writes config commands into the low-level Equalizer APO system driver.
## 🌟 The Baseline Constraint: Matching & Exceeding Samsung Adapt Sound
Samsung's system uses a basic "Can you hear the beep? Yes/No" pulsing approach that drops discrete, coarse equalizer filters into the Android media framework. To vastly exceed that performance baseline, this application introduces three major architectural upgrades:

   1. Granular Continuous Threshold Mapping: Instead of a simple binary "Yes/No" click, the user dials a continuous slider to find their exact decibel floor, resulting in an accurate auditory map.
   2. Expanded High-Fidelity Audiogram Resolution: Samsung maps a limited, generic frequency range (typically capping around 8kHz). This application extends tracking deep into high-fidelity spectrum bands (up to 16kHz) to capture age-related or noise-induced high-frequency roll-off.
   3. True Per-Channel Parametric Filters (Left/Right Isolation): Unlike standard graphics equalizers that shift whole chunks of sound lazily, this app calculates independent parametric peak filters mapped explicitly to the user's asymmetric hearing traits per ear.

------------------------------
## 2. Core Functional Requirements## 2.1 UI/UX Flow (The Personalization Wizard)
The application must present a simple step-by-step wizard. There should be no technical jargon, graphs, or matrixes visible to the user.

[ Welcome Screen ] ➔ [ Noise Check ] ➔ [ Left Ear Test ] ➔ [ Right Ear Test ] ➔ [ Optimization / Apply ]


* Step 1: Welcome & Setup: Instructs the user to wear headphones and ensure they are in a quiet room.
* Step 2: Environment Check: Brief ambient check/validation (or a reminder to close background apps).
* Step 3 & 4: Interactive Audiogram Test:
* Test both ears independently (Left Ear first, then Right Ear).
   * Exceeding Feature: Test 9 high-fidelity frequencies across the entire human hearing soundscape: 125Hz, 250Hz, 500Hz, 1000Hz, 2000Hz, 4000Hz, 8000Hz, 12000Hz, 16000Hz.
   * For each frequency, play a continuous pure sine wave beep.
   * Provide a single slider labeled: "Lower this slider until you can barely hear the tone."
   * Include a single "Next" button to jump to the subsequent frequency point once the threshold is dialed in.
* Step 5: Completion & Optimization: A single button labeled "Apply Adapt Sound Profile" that locks the tuning system-wide.

## 2.2 Frontend Audio Engine (Web Audio API)

* Must use the browser-native AudioContext to generate pure sine wave frequencies.
* Must utilize a StereoPannerNode to cleanly route the diagnostic tone exclusively to the target ear (Left or Right) during its respective phase.
* Must normalize volume thresholds between 0.0 and 1.0 inside JavaScript before passing data to the calculation module.

## 2.3 Audio Math & Tuning Logic (The Calculator)

* Target Baseline: Assume 0.05 to 0.1 represents standard, fully healthy hearing baseline volume for a reference pair of headphones.
* Inversion Calculation: If a user requires a higher volume threshold to hear a specific frequency band (e.g., 0.35 instead of 0.05), the app must calculate a matching positive logarithmic decibel boost for that band.
* Dynamic Clipping Protection (Preamp Headroom): To prevent severe digital audio clipping when frequencies are boosted, the engine must scan the final map, find the highest positive decibel boost added, and dynamically write a global negative preamp attenuation command matching that value.

## 2.4 Backend Driver Integration (Tauri to Equalizer APO)
Instead of processing live audio streams inside user-space, the application writes instructions directly to Equalizer APO's hot-reloaded configuration file.

* Target Path: C:\Program Files\EqualizerAPO\config\config.txt
* Tauri Command: Expose a Rust command apply_adapt_sound_profile(filters: Vec<FilterObject>).
* File Permissions: The Rust backend must request or possess adequate elevated file-writing permissions to successfully overwrite files inside Program Files.
* Real-time Modification: The configuration file must be overwritten entirely using the standardized Equalizer APO filter format syntax.

------------------------------
## 3. Equalizer APO Syntax Blueprint
The Rust backend must format the text output exactly like this so the Windows system engine can parse it immediately without a reboot:

# Open-AdaptSound Generated Profile
# Dynamic Headroom Reduction to Prevent Audio Distortion
Preamp: -6.5 dB

# Left Channel Calibrations
Filter: ON PK Fc 250 Hz Gain 1.5 dB Q 1.41 Channel: L
Filter: ON PK Fc 1000 Hz Gain 3.0 dB Q 1.41 Channel: L
Filter: ON PK Fc 4000 Hz Gain 6.5 dB Q 1.41 Channel: L
Filter: ON PK Fc 16000 Hz Gain 8.0 dB Q 1.41 Channel: L

# Right Channel Calibrations
Filter: ON PK Fc 250 Hz Gain 2.0 dB Q 1.41 Channel: R
Filter: ON PK Fc 1000 Hz Gain 2.5 dB Q 1.41 Channel: R
Filter: ON PK Fc 4000 Hz Gain 5.0 dB Q 1.41 Channel: R
Filter: ON PK Fc 16000 Hz Gain 4.5 dB Q 1.41 Channel: R

------------------------------
## 4. Technical Constraints & Non-Functional Requirements

* Zero Processing Latency: Real-time audio routing remains entirely native to the Windows kernel engine via Equalizer APO. The app introduces 0ms delay to gaming or video playback.
* Offline Operation: The entire app must run 100% locally on the user's machine. No remote network calls or telemetry are required for the hearing diagnostic.
* Lightweight Execution: The application footprint must remain minimal, consuming near-zero resources once minimized to the system tray.
