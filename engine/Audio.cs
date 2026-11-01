// Reading, playback, the mic and the enrolled-voice embedding.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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
        const int Steps = 8;

        static string Dir => Path.Combine(Engine.Root, "models", "supertonic");

        public static string[] Voices()
        {
            var d = Path.Combine(Dir, "voice_styles");
            return Directory.Exists(d) ? Directory.GetFiles(d, "*.json").Select(Path.GetFileNameWithoutExtension).OfType<string>().OrderBy(s => s).ToArray() : Array.Empty<string>();
        }

        public static byte[] Synthesize(string text, string voice, float speed)
        {
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
                var (wav, duration) = tts.Call(text, "ko", style, Steps, speed);
                int len = Math.Min(wav.Length, (int)(tts.SampleRate * duration[0]));
                return Wav.Encode(wav[..len], tts.SampleRate);
            }
        }
    }

    // Player plays one reading at a time; a new one or "stop" cuts the last.
    // Requests are handled in parallel, so each carries the extension's reading
    // number (gen): a stop for reading n cuts n and anything older, and a play
    // of a reading already stopped never starts — whichever arrives first.
    static class Player
    {
        sealed class Playing
        {
            public readonly WaveOutEvent Dev = new() { DesiredLatency = 120 };
            public readonly ManualResetEventSlim Done = new(false);
            public volatile bool Stopped;
            public long Gen;
        }

        static Playing? cur;
        static long stoppedGen = long.MinValue;
        static readonly object mu = new();

        // Play blocks until the reading is over; false if it was stopped.
        public static bool Play(byte[] wav, long gen)
        {
            using var reader = new WaveFileReader(new MemoryStream(wav));
            var p = new Playing { Gen = gen };
            p.Dev.PlaybackStopped += (_, _) => p.Done.Set();
            p.Dev.Init(reader);
            lock (mu)
            {
                if (gen <= stoppedGen)
                {
                    p.Dev.Dispose();
                    return false;
                }
                StopLocked();
                cur = p;
                p.Dev.Play();
            }
            p.Done.Wait();
            lock (mu) if (cur == p) cur = null;
            p.Dev.Dispose();
            return !p.Stopped;
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
            cur.Dev.Stop(); // PlaybackStopped releases the waiting Play
            cur = null;
        }
    }

    // Mic streams 16 kHz mono 16-bit audio in 50 ms pieces while it is on.
    static class Mic
    {
        static WaveInEvent? dev;
        static readonly object mu = new();

        public static void Set(bool on)
        {
            lock (mu)
            {
                if (on == (dev != null)) return;
                if (!on)
                {
                    dev!.StopRecording();
                    dev.Dispose();
                    dev = null;
                    return;
                }
                var d = new WaveInEvent { WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 50, NumberOfBuffers = 4 };
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
