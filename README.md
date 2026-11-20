# aglink-voice

Voice conversation with Claude Code in VS Code — speak a request, hear the
answer — running entirely on the PC: Whisper recognition, Supertonic reading
(10 voices), an enrolled-voice check (ECAPA) and the "아글링크" wake word.
Grown out of the [aglink](https://github.com/tyranno/aglink) desktop app's
voice, for people who do not run aglink.

| Folder | What |
|---|---|
| `extension/` | the VS Code extension (plain JavaScript, no build step) |
| `extension/core/` | the conversation logic, no VS Code: listening, wake word, voice check, echo filter, commands, what to read |
| `engine/` | `aglink-voice-engine.exe` (C#, .NET 9 self-contained): mic, playback, Whisper server, Supertonic, ECAPA, Ctrl+V/Enter into VS Code |
| `installer/` | the setup that puts engine, models and extension on a PC |
| `docs/plan.md` | the plan and where it stands |

## Build and test

```powershell
# engine
dotnet publish engine -c Release
# extension tests (Node 18+)
cd extension; node --test test/*.test.js
# the conversation on the real engine, recordings in place of the mic
node extension/tools/live-check.js <engine.exe> <root> <enroll.wav> <user.wav> [<other.wav>]
# package and install the extension
powershell -NoProfile -ExecutionPolicy Bypass -File extension\install.ps1
```

The engine's root folder holds `models\` and `whisper\`; they are not in
git. What each setup file takes from it (`-Root`, default
`%USERPROFILE%\.aglink\voice-build\root`):

| Setup | From the root | From the repo / Windows |
|---|---|---|
| CPU base (`aglink-voice-setup`) | `models\ggml-small.bin` (Whisper), `models\ecapa.onnx` (voice check), `models\silero_vad.onnx` (voice activity), `models\supertonic\onnx\`, `models\supertonic\voice_styles\`; `whisper\cpu\whisper-server.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu-*.dll` | the published engine, `engine\native\rnnoise.dll`, `engine\LICENSE-Supertonic`, the extension's `.vsix`; the VC++ runtime DLLs next to the engine and `whisper\cpu\` |
| GPU add-on (`aglink-voice-gpu`) | `whisper\cuda\` with the same whisper files plus `ggml-cuda.dll`, `cublas64_12.dll`, `cublasLt64_12.dll`, `cudart64_12.dll` | the VC++ runtime DLLs next to them |

The VC++ runtime DLLs are `msvcp140.dll`, `msvcp140_1.dll`, `msvcp140_2.dll`,
`vcruntime140.dll`, `vcruntime140_1.dll`, `vcomp140.dll` from `System32`.
`build.ps1` checks for all of these before it builds anything and lists what
is missing. The engine also uses `models\ggml-small-q8_0.bin` (CPU) or
`models\ggml-large-v3-turbo-q8_0.bin` (GPU) when they are there, but no setup
ships them.

## Setup files

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1 [-Root <engine root>]
```

builds, in `dist\` (NSIS 3 needed):

- `aglink-voice-setup-<ver>.exe` (~870 MB): engine, models, Whisper on the
  CPU, the extension. Installs for the current user into
  `%LOCALAPPDATA%\aglink-voice` without administrator rights, then installs
  the extension with VS Code's `code`. Uninstall from Windows' app list.
- `aglink-voice-gpu-<ver>.exe` (~310 MB): Whisper on NVIDIA GPUs, added to an
  installed setup.

Nothing is downloaded at install. The Visual C++ runtime is copied next to
the engine and Whisper, so PCs without it work. On PCs without Node.js the
Claude Code Stop hook runs in Windows PowerShell.
