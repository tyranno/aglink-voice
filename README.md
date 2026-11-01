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

The engine's root folder holds `models\` (`ggml-small.bin`, `ecapa.onnx`,
`supertonic\`) and `whisper\` (`cuda\`, `cpu\`). They are not in git.

## Setup files

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installeruild.ps1 [-Root <engine root>]
```

builds, in `dist\` (NSIS 3 needed):

- `aglink-voice-setup-<ver>.exe` (~870 MB): engine, models, Whisper on the
  CPU, the extension. Installs for the current user into
  `%LOCALAPPDATA%glink-voice` without administrator rights, then installs
  the extension with VS Code's `code`. Uninstall from Windows' app list.
- `aglink-voice-gpu-<ver>.exe` (~1 GB): Whisper on NVIDIA GPUs, added to an
  installed setup.

Nothing is downloaded at install. The Visual C++ runtime is copied next to
the engine and Whisper, so PCs without it work. On PCs without Node.js the
Claude Code Stop hook runs in Windows PowerShell.
