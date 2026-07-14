# Open-AdaptSound

**Personal hearing equalizer for Windows 10/11** — free, offline, open source.

Run a short **per-ear beep hearing test**, build a **left/right parametric EQ** from your thresholds, and apply it **system-wide** with [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) so games, browsers, calls, and music all use the same profile.

[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)](https://github.com/SREESAIARJUN/open-adaptsound/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/SREESAIARJUN/open-adaptsound)](https://github.com/SREESAIARJUN/open-adaptsound/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/SREESAIARJUN/open-adaptsound/total)](https://github.com/SREESAIARJUN/open-adaptsound/releases)

**Official site:** [sreesaiarjun.github.io/open-adaptsound](https://sreesaiarjun.github.io/open-adaptsound/) · **Download:** [Windows installer](https://github.com/SREESAIARJUN/open-adaptsound/releases/latest) · **Requires:** [Equalizer APO](https://sourceforge.net/projects/equalizerapo/files/latest/download)

---

## Why use a personal hearing EQ on Windows?

Most PCs ship **one flat mix for everyone**. They do not know:

- which frequencies *you* hear less well (age, noise, ear asymmetry)
- how *your* headphones color the sound
- that music apps, Discord, and games each need the same compensation

Typical “solutions” fall short:

| Approach | Limitation |
| --- | --- |
| Music-player EQ only | Only that app |
| Generic graphic EQ | You guess the bands |
| Phone hearing personalization | Not system-wide on a Windows desktop |
| Full Peace / manual Equalizer APO UI | Powerful, but easy to misconfigure |

**Open-AdaptSound** is the missing step: a **guided hearing check** that outputs a real **Equalizer APO profile** for the whole PC—without living in a filter matrix.

### What you get in daily use

- Clearer **speech and game footsteps** in bands you’re weak on  
- Less “muffled highs” if you roll off above ~8–12 kHz  
- **Separate left and right** curves when ears differ  
- **No extra latency** from this app (EQ runs inside Equalizer APO)  
- One profile for **Spotify, YouTube, Steam, Zoom, Discord**, etc.

Intensity presets: **Gentle · Balanced · Full**.

---

## Who this is for

Searchers and users looking for tools like:

- personal / custom **hearing equalizer for Windows**
- **system-wide EQ** for headphones (not just one media player)
- **Equalizer APO** hearing test or auto EQ from a listening check
- **left and right ear** equalizer / asymmetric hearing compensation
- Windows alternative to phone-style **adapt sound / hearing personalization**
- simple **beep Yes/No hearing test** that ends in a usable EQ profile

Also useful if you already run Equalizer APO and want a **fast, measured starting curve** instead of dialing 15 bands by ear.

---

## How it works

```
Headphones → volume locked to fixed reference (calibration)
           → beep Yes/No test (15 bands × 2 ears, dB-domain staircase)
           → gain map relative to your best band + preamp headroom
           → Equalizer APO config (hot-reload)
           → all Windows audio apps
```

1. **Calibration** — Windows volume is locked to a **fixed reference level** during the test (the same trick phone hearing tests use) and restored afterward, so results don't depend on where your volume slider was. Any already-applied profile is suspended so retests stay clean.  
2. **Hearing check** — pure sine beeps, left then right, **15 frequencies up to 16 kHz**. Answer Yes/No. A decibel-domain adaptive staircase (like clinical audiometry) homes in on your true threshold per band, with equal-loudness weighting so lows/highs are tested fairly.  
3. **Profile math** — thresholds → dB boosts per ear, computed **relative to your best band** (self-calibrating for your headphones); a global preamp cut prevents clipping.  
4. **Apply** — writes `Open-AdaptSound.txt` and `Include:` into Equalizer APO (other APO lines kept).  
5. **Everyday use** — APO equalizes the audio stack; Open-AdaptSound can sit in the system tray.

Not a media player. Not a VST. **Configuration app + Equalizer APO.**

---

## Features

- Offline beep test (**Y** / **N** keys)
- **Calibrated test level** — system volume locked to a fixed reference during the test, auto-restored after
- Full map: `125 · 250 · 500 · 750 · 1k · 1.5k · 2k · 3k · 4k · 6k · 8k · 10k · 12k · 14k · 16k` Hz  
- dB-domain adaptive staircase thresholds with equal-loudness weighting  
- Independent **L/R parametric peaks** (`Channel: L` / `Channel: R`)  
- Dynamic **preamp headroom**  
- Safe merge with existing Equalizer APO configs  
- Tray, re-apply last profile, reset, export  

---

## Install (Windows)

### 1. Equalizer APO (required once)

1. Download [Equalizer APO](https://sourceforge.net/projects/equalizerapo/files/latest/download)  
2. Device Selector → enable your **headphones**  
3. **Reboot** when asked  

Why we don’t ship APO inside our installer: [docs/EQUALIZER-APO.md](docs/EQUALIZER-APO.md).

### 2. Open-AdaptSound

1. Get the [latest release installer](https://github.com/SREESAIARJUN/open-adaptsound/releases/latest) (`Open-AdaptSound_*_x64-setup.exe`)  
2. Run the app → quiet room → beep test → **Apply**  

### Developers

```bash
npm install
npm run dev
npm test
npm run build
```

---

## Compared to similar tools

| Need | Open-AdaptSound | Peace GUI | Music app EQ | Phone adapt sound |
| --- | --- | --- | --- | --- |
| Guided hearing test | Yes | No (manual) | Rarely | Often limited |
| System-wide (games + browser) | Yes (via APO) | Yes | No | Phone only |
| L/R independent | Yes | Manual | Usually no | Varies |
| Zero app playback latency | Yes | Yes (APO) | App-only | N/A |
| Beginner path | Wizard | Advanced UI | Easy but local | Easy but mobile |

Open-AdaptSound **uses** Equalizer APO; it does not replace Peace for power users—it **feeds** APO with a measured personal profile.

---

## FAQ

**Is this a medical hearing test?**  
No. It’s a practical headphone listening check for EQ, not a clinical audiogram or diagnosis.

**Do I need Equalizer APO?**  
Yes, for system-wide results. This app writes the profile; APO applies it.

**Will it slow games?**  
Equalizer APO is low-latency system EQ. Open-AdaptSound is not in the audio path after you apply.

**Can I keep my other APO filters?**  
Yes. We add an `Include:` for our file instead of wiping `config.txt`.

**Headphones or speakers?**  
Designed for **headphones** (true left/right isolation during the test).

More: [docs/EQUALIZER-APO.md](docs/EQUALIZER-APO.md) · [docs/FAQ.md](docs/FAQ.md)

---

## Project links

| | |
| --- | --- |
| Website | https://sreesaiarjun.github.io/open-adaptsound/ |
| Releases / installer | https://github.com/SREESAIARJUN/open-adaptsound/releases |
| Source | https://github.com/SREESAIARJUN/open-adaptsound |
| Equalizer APO | https://sourceforge.net/projects/equalizerapo/ |
| Issues | https://github.com/SREESAIARJUN/open-adaptsound/issues |

**Keywords:** Windows personal EQ, hearing compensation, Equalizer APO profile, headphone equalizer, system-wide equalizer, left right ear EQ, beep hearing test, adaptive staircase, parametric peaking filters.

---

## License

MIT. Not affiliated with Equalizer APO, Peace, or any phone OEM.
