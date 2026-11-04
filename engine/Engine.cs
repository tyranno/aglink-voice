// aglink-voice-engine: the voice of the aglink VS Code extension when the aglink
// desktop app is not there. One process does what the desktop spreads over
// WebView2, Go and helper servers: the mic, recognition (whisper.cpp server,
// GPU when there is an NVIDIA card), reading (Supertonic), playback, the
// enrolled-voice embedding (ECAPA, ONNX) and pressing Ctrl+V, Enter in VS Code.
//
// The extension starts it (aglink-voice-engine.exe <root> [--no-whisper]; the
// flag is for reading answers only, Whisper then waits for "whisper") and talks JSON lines: requests on stdin carry an
// "id" and get one answer line with the same id; "ev" lines are events
// (mic audio, status). Only one engine runs per user: the mic and the GPU are
// not shared between VS Code windows.
//
//   {"id":1,"op":"status"}                          → {"id":1,"ok":true,"whisper":"gpu"|"cpu"|"starting"|"off",...}
//   {"id":2,"op":"tts","text":"…","voice":"M2","speed":1.0,"steps":8}  → {"id":2,"ok":true,"wav":"<base64>"}
//                                                    steps: 2–16, default 8; fewer is faster and a little rougher
//   {"id":3,"op":"play","wav":"<base64>","gen":7,"device":""}  → answered when it has played (or was stopped);
//                                                    device: an output name from "devices", blank = Windows' default
//   {"id":10,"op":"devices"}                        → {"id":10,"ok":true,"inputs":[names],"outputs":[names]}
//   {"ev":"deviceMissing","kind":"mic"|"output","name":"…"}  the chosen device is gone; the default is used
//   {"id":9,"op":"whisper"}                         starts Whisper if the engine was started with --no-whisper
//   {"id":4,"op":"stop","gen":7}                    stops reading 7 and older (no gen: whatever plays)
//   {"id":5,"op":"mic","on":true,"device":""}       → {"ev":"mic","pcm":"<base64 16 kHz mono s16>"} every 50 ms;
//                                                    device: an input name from "devices", blank = Windows' default
//   {"id":6,"op":"transcribe","wav":"<base64>"}     → {"id":6,"ok":true,"text":"…"}
//   {"id":7,"op":"embed","wav":"<base64>"}          → {"id":7,"ok":true,"embedding":[192 floats]}
//   {"id":8,"op":"paste","pid":123,"title":"etc"}   → {"id":8,"ok":true} or {"ok":false,"error":"…"}
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Supertonic;

namespace AglinkVoice
{
    static class Engine
    {
        static StreamWriter stdout = null!;
        static readonly object outLock = new();
        public static string Root = "";

        public static void Send(object msg)
        {
            string line = JsonSerializer.Serialize(msg);
            lock (outLock) stdout.WriteLine(line);
        }

        public static void Log(string s) => Console.Error.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] {s}");

        static int Main(string[] args)
        {
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            Console.SetOut(Console.Error); // Supertonic's helper prints; answers keep stdout to themselves
            Root = args.Length > 0 && !args[0].StartsWith("--") ? args[0] : Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));
            bool readOnly = args.Contains("--no-whisper"); // only reading answers: Whisper waits for "whisper"

            using var single = new Mutex(true, @"Local\aglink-voice-engine", out bool first);
            if (!first)
            {
                Send(new { ev = "fatal", error = "다른 VS Code 창에서 음성을 쓰고 있어요" });
                return 2;
            }

            if (!readOnly) StartWhisper();
            // Load the reading model now, off the request path: done lazily it
            // added about a second to the first answer read after voice went on.
            _ = Task.Run(() =>
            {
                try { Speech.Warm(); }
                catch (Exception e) { Log($"reading model warm-up failed: {e.Message}"); }
            });
            Send(new { ev = "ready" });

            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string? line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                JsonObject req;
                try
                {
                    req = JsonNode.Parse(line)!.AsObject();
                }
                catch (Exception e)
                {
                    Log($"bad request: {e.Message}");
                    continue;
                }
                _ = Task.Run(() => Handle(req));
            }
            // The extension is gone (its window closed): nothing is left running.
            Mic.Set(false);
            Player.Stop();
            Whisper.Stop();
            return 0;
        }

        static void StartWhisper() => Whisper.Start(Path.Combine(Root, "whisper"), WhisperModel());

        // WhisperModel prefers the 8-bit small model when it is installed: on a
        // CPU it recognises ~15 % faster than the full-precision one with the
        // same text (measured on a CPU-only PC). Without it the original is used.
        static string WhisperModel()
        {
            foreach (var name in new[] { "ggml-small-q8_0.bin", "ggml-small.bin" })
            {
                var p = Path.Combine(Root, "models", name);
                if (File.Exists(p)) return p;
            }
            return Path.Combine(Root, "models", "ggml-small.bin");
        }

        static void Handle(JsonObject req)
        {
            var id = req["id"]?.GetValue<long>() ?? 0;
            string op = req["op"]?.GetValue<string>() ?? "";
            try
            {
                switch (op)
                {
                    case "status":
                        Send(new { id, ok = true, whisper = Whisper.State, voices = Speech.Voices(), enrolled = false });
                        break;
                    case "tts":
                        {
                            string text = req["text"]?.GetValue<string>() ?? "";
                            string voice = req["voice"]?.GetValue<string>() ?? "M2";
                            float speed = (float)(req["speed"]?.GetValue<double>() ?? 1.0);
                            int steps = req["steps"]?.GetValue<int>() ?? Speech.DefaultSteps;
                            Send(new { id, ok = true, wav = Convert.ToBase64String(Speech.Synthesize(text, voice, speed, steps)) });
                            break;
                        }
                    case "play":
                        {
                            var wav = Convert.FromBase64String(req["wav"]?.GetValue<string>() ?? "");
                            bool played = Player.Play(wav, req["gen"]?.GetValue<long>() ?? 0, req["device"]?.GetValue<string>() ?? "");
                            Send(new { id, ok = true, stopped = !played });
                            break;
                        }
                    case "whisper":
                        StartWhisper();
                        Send(new { id, ok = true, whisper = Whisper.State });
                        break;
                    case "stop":
                        Player.Stop(req["gen"]?.GetValue<long>() ?? long.MaxValue);
                        Send(new { id, ok = true });
                        break;
                    case "mic":
                        Mic.Set(req["on"]?.GetValue<bool>() ?? false, req["device"]?.GetValue<string>() ?? "");
                        Send(new { id, ok = true });
                        break;
                    case "devices":
                        Send(new { id, ok = true, inputs = Devices.Inputs(), outputs = Devices.Outputs() });
                        break;
                    case "transcribe":
                        {
                            var wav = Convert.FromBase64String(req["wav"]?.GetValue<string>() ?? "");
                            Send(new { id, ok = true, text = Whisper.Transcribe(wav) });
                            break;
                        }
                    case "embed":
                        {
                            var wav = Convert.FromBase64String(req["wav"]?.GetValue<string>() ?? "");
                            Send(new { id, ok = true, embedding = Speaker.Embed(wav) });
                            break;
                        }
                    case "paste":
                        {
                            int pid = req["pid"]?.GetValue<int>() ?? 0;
                            string title = req["title"]?.GetValue<string>() ?? "";
                            string? err = Paste.Send(pid, title);
                            if (err == null) Send(new { id, ok = true });
                            else Send(new { id, ok = false, error = err });
                            break;
                        }
                    default:
                        Send(new { id, ok = false, error = "unknown op: " + op });
                        break;
                }
            }
            catch (Exception e)
            {
                Log($"{op} failed: {e}");
                Send(new { id, ok = false, error = e.Message });
            }
        }
    }
}
