// Reading, playback, the mic and the enrolled-voice embedding.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using NAudio.Wave;
using Supertonic;

namespace AglinkVoice
{
    static class Wav
    {
        public static byte[] Encode(float[] samples, int rate)
        {
            using var ms = new MemoryStream();
            using var w = new BinaryWriter(ms);
            int dataSize = samples.Length * 2;
            w.Write(Encoding.ASCII.GetBytes("RIFF"));
            w.Write(36 + dataSize);
            w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
            w.Write(16);
            w.Write((short)1);
            w.Write((short)1);
            w.Write(rate);
            w.Write(rate * 2);
            w.Write((short)2);
            w.Write((short)16);
            w.Write(Encoding.ASCII.GetBytes("data"));
            w.Write(dataSize);
            foreach (var s in samples) w.Write((short)(Math.Clamp(s, -1f, 1f) * 32767));
            w.Flush();
            return ms.ToArray();
        }

        // Decode reads a PCM wav as mono float samples at 16 kHz (what the
        // extension sends is already that; anything else is mixed and resampled).
        public static float[] Decode16k(byte[] wav)
        {
            using var r = new WaveFileReader(new MemoryStream(wav));
            var prov = r.ToSampleProvider();
            int ch = prov.WaveFormat.Channels, rate = prov.WaveFormat.SampleRate;
            var all = new List<float>();
            var buf = new float[4096 * ch];
            int n;
            while ((n = prov.Read(buf, 0, buf.Length)) > 0)
                for (int i = 0; i + ch <= n; i += ch)
                {
                    float s = 0;
                    for (int c = 0; c < ch; c++) s += buf[i + c];
                    all.Add(s / ch);
                }
            if (rate == 16000) return all.ToArray();
            var outp = new float[(long)all.Count * 16000 / rate];
            for (int i = 0; i < outp.Length; i++)
            {
                double pos = (double)i * rate / 16000;
                int a = (int)pos;
                double f = pos - a;
                float x = all[Math.Min(a, all.Count - 1)], y = all[Math.Min(a + 1, all.Count - 1)];
                outp[i] = (float)(x + (y - x) * f);
            }
            return outp;
        }
    }

    static class Speech
    {
        static TextToSpeech? tts;
        static readonly Dictionary<string, Style> styles = new();
        static readonly object mu = new();
        // Diffusion steps per sentence: fewer is faster (about linearly) and a
        // little rougher. The extension may ask for fewer to start reading sooner.
        public const int DefaultSteps = 8;

        static string Dir => Path.Combine(Engine.Root, "models", "supertonic");

        public static string[] Voices()
        {
            var d = Path.Combine(Dir, "voice_styles");
            return Directory.Exists(d) ? Directory.GetFiles(d, "*.json").Select(Path.GetFileNameWithoutExtension).OfType<string>().OrderBy(s => s).ToArray() : Array.Empty<string>();
        }

        public static byte[] Synthesize(string text, string voice, float speed, int steps = DefaultSteps)
        {
            steps = Math.Clamp(steps, 2, 16);
            text = text.Trim();
            if (text.Length == 0) throw new ArgumentException("빈 문장");
            if (voice.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || voice.Contains("..")) voice = "M2";
            speed = Math.Clamp(speed, 0.7f, 2.0f);
            lock (mu)
            {
                tts ??= Helper.LoadTextToSpeech(Path.Combine(Dir, "onnx"), false);
                if (!styles.TryGetValue(voice, out var style))
                {
                    var p = Path.Combine(Dir, "voice_styles", voice + ".json");
                    if (!File.Exists(p)) p = Path.Combine(Dir, "voice_styles", "M2.json");
                    style = Helper.LoadVoiceStyle(new List<string> { p });
                    styles[voice] = style;
                }
                var (wav, duration) = tts.Call(text, "ko", style, steps, speed);
                int len = Math.Min(wav.Length, (int)(tts.SampleRate * duration[0]));
                return Wav.Encode(wav[..len], tts.SampleRate);
            }
        }
    }

    // Player plays one reading at a time; a new one or "stop" cuts the last.
    // Requests are handled in parallel, so each carries the extension's reading
    // number (gen): a stop for reading n cuts n and anything older, and a play
    // of a reading already stopped never starts — whichever arrives first.
    //
    // The whole clip goes to Windows at once (PlaySound from memory, as the
    // desktop app plays): streaming it through WaveOut's small buffers broke
    // up whenever the next sentence's synthesis had the CPU.
    static class Player
    {
        sealed class Playing
        {
            public readonly ManualResetEventSlim Done = new(false);
            public volatile bool Stopped;
            public long Gen;
        }

        const uint SND_ASYNC = 0x1, SND_NODEFAULT = 0x2, SND_MEMORY = 0x4;

        [DllImport("winmm.dll", SetLastError = true)]
        static extern bool PlaySound(IntPtr sound, IntPtr module, uint flags);

        static Playing? cur;
        static WaveOutEvent? curOut; // set while cur plays on a chosen device
        static long stoppedGen = long.MinValue;
        static readonly object mu = new();

        // Play blocks until the reading is over; false if it was stopped. device
        // is an output name from Devices.Outputs(); blank is Windows' default,
        // which keeps PlaySound. A name no longer present (headset unplugged)
        // falls back to the default and says so.
        public static bool Play(byte[] wav, long gen, string device = "")
        {
            int? number = Devices.OutputNumber(device);
            if (number == null) Engine.Send(new { ev = "deviceMissing", kind = "output", name = device });
            return number is int n && n >= 0 ? PlayOn(wav, gen, n) : PlayDefault(wav, gen);
        }

        // PlayOn plays on one WinMM output device. PlaySound cannot pick a
        // device, so this goes through WaveOut — but with the whole clip already
        // in memory and a generous buffer, which is what keeps it from breaking
        // up while the next sentence is being synthesized.
        static bool PlayOn(byte[] wav, long gen, int number)
        {
            var p = new Playing { Gen = gen };
            using var reader = new WaveFileReader(new MemoryStream(wav));
            using var o = new WaveOutEvent { DeviceNumber = number, DesiredLatency = 300, NumberOfBuffers = 3 };
            o.Init(reader);
            o.PlaybackStopped += (_, _) => p.Done.Set();
            lock (mu)
            {
                if (gen <= stoppedGen) return false;
                StopLocked();
                cur = p;
                curOut = o;
                o.Play();
            }
            p.Done.Wait(reader.TotalTime + TimeSpan.FromSeconds(2));
            lock (mu)
            {
                if (cur == p) { cur = null; curOut = null; }
            }
            return !p.Stopped;
        }

        static bool PlayDefault(byte[] wav, long gen)
        {
            TimeSpan length;
            using (var reader = new WaveFileReader(new MemoryStream(wav))) length = reader.TotalTime;
            var p = new Playing { Gen = gen };
            var pin = GCHandle.Alloc(wav, GCHandleType.Pinned); // Windows reads it while it plays
            try
            {
                lock (mu)
                {
                    if (gen <= stoppedGen) return false;
                    StopLocked();
                    if (!PlaySound(pin.AddrOfPinnedObject(), IntPtr.Zero, SND_MEMORY | SND_ASYNC | SND_NODEFAULT))
                        throw new InvalidOperationException("재생하지 못했어요");
                    cur = p;
                }
                p.Done.Wait(length + TimeSpan.FromMilliseconds(80));
                lock (mu) if (cur == p) cur = null;
                return !p.Stopped;
            }
            finally
            {
                lock (mu) if (cur == null) PlaySound(IntPtr.Zero, IntPtr.Zero, 0); // nothing still reads the buffer
                pin.Free();
            }
        }

        public static void Stop(long gen = long.MaxValue)
        {
            lock (mu)
            {
                if (gen != long.MaxValue && gen > stoppedGen) stoppedGen = gen;
                if (cur != null && cur.Gen <= gen) StopLocked();
            }
        }

        static void StopLocked()
        {
            if (cur == null) return;
            cur.Stopped = true;
            if (curOut != null)
            {
                curOut.Stop();
                curOut = null;
            }
            else PlaySound(IntPtr.Zero, IntPtr.Zero, 0);
            cur.Done.Set(); // releases the waiting Play
            cur = null;
        }
    }

    // Devices are the WinMM recording and output devices by name (Windows cuts
    // these names at 31 characters). The extension stores the name the user
    // picked; blank means Windows' default device.
    static class Devices
    {
        public static string[] Inputs()
        {
            var a = new string[WaveInEvent.DeviceCount];
            for (int i = 0; i < a.Length; i++) a[i] = WaveInEvent.GetCapabilities(i).ProductName;
            return a;
        }

        // NAudio.WinMM has no output-device listing (that lives with WinForms'
        // WaveOut), so ask winmm directly.
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WaveOutCaps
        {
            public ushort Mid, Pid;
            public uint DriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
            public uint Formats;
            public ushort Channels, Reserved;
            public uint Support;
        }

        [DllImport("winmm.dll")] static extern int waveOutGetNumDevs();
        [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "waveOutGetDevCapsW")]
        static extern int waveOutGetDevCaps(IntPtr id, ref WaveOutCaps caps, int size);

        public static string[] Outputs()
        {
            var a = new string[waveOutGetNumDevs()];
            for (int i = 0; i < a.Length; i++)
            {
                var c = new WaveOutCaps();
                a[i] = waveOutGetDevCaps((IntPtr)i, ref c, Marshal.SizeOf<WaveOutCaps>()) == 0 ? c.Name : "";
            }
            return a;
        }

        // -1 is Windows' default (WAVE_MAPPER); null means a named device that is
        // not there now.
        public static int? InputNumber(string name) => Find(Inputs(), name);
        public static int? OutputNumber(string name) => Find(Outputs(), name);

        static int? Find(string[] names, string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return -1;
            int i = Array.IndexOf(names, name);
            if (i >= 0) return i;
            // A setting may hold the longer Windows name; WinMM's is its first 31 characters.
            for (int j = 0; j < names.Length; j++)
                if (names[j].Length > 0 && name.StartsWith(names[j], StringComparison.Ordinal)) return j;
            return null;
        }
    }

    // Mic streams 16 kHz mono 16-bit audio in 50 ms pieces while it is on.
    // device is an input name from Devices.Inputs(); blank is Windows' default
    // input (WAVE_MAPPER) — not device 0, which is whatever WinMM lists first
    // and was the built-in mic even with a headset chosen in Windows.
    static class Mic
    {
        static WaveInEvent? dev;
        static string devName = "";
        static readonly object mu = new();

        public static void Set(bool on, string device = "")
        {
            lock (mu)
            {
                device ??= "";
                if (on && dev != null && device == devName) return;
                if (!on && dev == null) return;
                if (dev != null)
                {
                    dev.StopRecording();
                    dev.Dispose();
                    dev = null;
                }
                if (!on) return;
                int? number = Devices.InputNumber(device);
                if (number == null) Engine.Send(new { ev = "deviceMissing", kind = "mic", name = device });
                var d = new WaveInEvent { DeviceNumber = number ?? -1, WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 50, NumberOfBuffers = 4 };
                d.DataAvailable += (_, e) =>
                {
                    if (e.BytesRecorded > 0) Engine.Send(new { ev = "mic", pcm = Convert.ToBase64String(e.Buffer, 0, e.BytesRecorded) });
                };
                d.RecordingStopped += (_, e) =>
                {
                    if (e.Exception != null) Engine.Send(new { ev = "micError", error = e.Exception.Message });
                };
                d.StartRecording();
                dev = d;
                devName = device;
            }
        }
    }

    // Speaker turns a clip into ECAPA's 192-number voice embedding; comparing
    // embeddings (cosine) and learning the user's voice is the extension's job.
    static class Speaker
    {
        static InferenceSession? sess;
        static readonly object mu = new();

        public static float[] Embed(byte[] wav)
        {
            var samples = Wav.Decode16k(wav);
            if (samples.Length < 1600) throw new ArgumentException("too short");
            lock (mu)
            {
                sess ??= new InferenceSession(Path.Combine(Engine.Root, "models", "ecapa.onnx"));
                var input = new DenseTensor<float>(samples, new[] { 1, samples.Length });
                using var res = sess.Run(new[] { NamedOnnxValue.CreateFromTensor("wav", input) });
                return res.First().AsTensor<float>().ToArray();
            }
        }
    }
}
