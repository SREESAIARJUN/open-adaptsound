# FAQ — Open-AdaptSound

## What is Open-AdaptSound?

A free Windows app that runs a **per-ear beep hearing test**, converts your answers into a **parametric EQ profile**, and applies it **system-wide** through **Equalizer APO**.

## What problems does it solve?

- “Music EQ only works in Spotify”
- “I can’t hear high frequencies as well as before”
- “My ears aren’t the same left vs right”
- “Equalizer APO is powerful but I don’t know which gains to set”
- “I want something like phone hearing personalization on my PC”

## Equalizer APO

### Do I need it?

**Yes**, for system-wide EQ. Open-AdaptSound only writes config files.

### Do I need to reboot every time?

**Reboot once** after installing APO on your device. Changing the Adapt Sound profile later **hot-reloads** (no reboot).

### Why isn’t APO inside the installer?

Device selection is interactive, and first install expects a reboot. See [EQUALIZER-APO.md](EQUALIZER-APO.md).

## Hearing test

### Why does my Windows volume change during the test?

The test **locks system volume to a fixed reference level** so results don't depend on where your volume slider happens to be — the same approach phone hearing tests use. Your previous volume (and any active profile) is **restored automatically** when the test ends.

### How many frequencies?

**15 per ear**, from **125 Hz to 16 kHz**.

### Is it clinical?

**No.** Not a medical audiogram. For headphone EQ only.

### Can I use speakers?

The test assumes **headphones** so left/right tones stay isolated.

## Privacy

100% offline for the diagnostic. No account, no telemetry required.

## Related searches

People often find this project when looking for:

- personal hearing equalizer Windows  
- Equalizer APO hearing test  
- system wide headphone EQ  
- left right ear equalizer  
- hearing loss compensation EQ PC  
- auto EQ from listening test Windows  
