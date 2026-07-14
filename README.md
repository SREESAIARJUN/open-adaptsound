# Open-AdaptSound

**Personal hearing equalizer for Windows.**  
Beep test per ear → frequency map → parametric EQ written to [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) for system-wide sound.

![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows)
![License](https://img.shields.io/badge/license-MIT-green)

## Why this app

Windows plays one generic mix. It doesn’t know your ears, your headphones, or which frequencies you’ve lost. Per-app EQs stay in one player; graphic sliders make you guess.

Open-AdaptSound measures **your** hearing on **your** headphones, then applies one profile **everywhere** (games, browser, calls, video) through Equalizer APO—without a cluttered EQ matrix.

| Without | With |
| --- | --- |
| Factory / one-size-fits-all sound | Matched to how you hear |
| EQ only inside one app | System-wide via Equalizer APO |
| Guessing boost bands | Beep Yes/No finds thresholds |
| Same curve both ears | Independent left / right |
| Extra DSP app in the path | Config-only; APO does the work |
| Complex equalizer UIs | Listen → answer → apply |

**Result:** clearer speech and detail where you’re weak; less over-boost where you’re fine. Intensity: Gentle / Balanced / Full.

## How it works

Local configurator only—not a player or live DSP.

1. **Hearing check** — sine beeps, L then R, **15 bands to 16 kHz**. Yes/No; staircase finds softest level per band.  
2. **Profile** — thresholds → dB gains + preamp headroom.  
3. **Apply** — `Open-AdaptSound.txt` + `Include:` in Equalizer APO (hot-reload).  
4. **Use** — APO equalizes all apps; this app can stay in the tray.

```
headphones → beep test → Open-AdaptSound → Equalizer APO → all apps
```

## Equalizer APO (required)

System EQ needs Equalizer APO installed on your headphones.

1. Install [Equalizer APO](https://sourceforge.net/projects/equalizerapo/files/latest/download)  
2. Device Selector → enable headphones  
3. **Reboot** when asked  
4. Open this app → test → Apply  

We don’t bundle APO (device pick + reboot can’t be fully automated). Details: [docs/EQUALIZER-APO.md](docs/EQUALIZER-APO.md).

## Features

- Beep Yes/No test (keys **Y** / **N**)
- 15 bands/ear: `125–16k` Hz (incl. 750, 1.5k, 3k, 6k, 10k, 12k, 14k)
- Adaptive staircase · L/R peaking filters · preamp headroom
- Safe config merge · tray · re-apply / reset / export

## Install

1. Equalizer APO → headphones → reboot  
2. [Release installer](https://github.com/SREESAIARJUN/open-adaptsound/releases): `Open-AdaptSound_*_x64-setup.exe`  
3. Beep test → Apply  

```bash
npm install && npm run dev    # develop
npm test && npm run build     # test + NSIS
```

## License

MIT. Not affiliated with Equalizer APO or other vendors.
