// Recognition: a resident whisper.cpp server, the CUDA build when the PC has
// an NVIDIA driver (~0.3 s a clip on a GTX 1060), else the CPU build.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace AglinkVoice
{
    static class Whisper
    {
        static Process? proc;
        static string baseUrl = "";
        static readonly HttpClient http = new() { Timeout = TimeSpan.FromMinutes(2) };
        static readonly SemaphoreSlim one = new(1, 1);
        public static volatile string State = "starting"; // starting | gpu | cpu | off

        public static void Start(string dir, string model)
        {
            Task.Run(() =>
            {
                bool gpu = NativeLibrary.TryLoad("nvcuda.dll", out var h);
                if (gpu) NativeLibrary.Free(h);
                foreach (var (sub, name) in gpu ? new[] { ("cuda", "gpu"), ("cpu", "cpu") } : new[] { ("cpu", "cpu") })
                {
                    var exe = Path.Combine(dir, sub, "whisper-server.exe");
                    if (!File.Exists(exe) || !File.Exists(model)) continue;
                    try
                    {
                        Launch(exe, model);
                        State = name;
                        Engine.Log($"whisper-server ready ({name})");
                        Engine.Send(new { ev = "status", whisper = name });
                        return;
                    }
                    catch (Exception e)
                    {
                        Engine.Log($"whisper-server {name} failed: {e.Message}");
                        Stop();
                    }
                }
                State = "off";
                Engine.Send(new { ev = "status", whisper = "off" });
            });
        }

        static void Launch(string exe, string model)
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int port = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            var psi = new ProcessStartInfo(exe)
            {
                WorkingDirectory = Path.GetDirectoryName(exe)!,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in new[] { "-m", model, "-l", "ko", "-t", Math.Min(Environment.ProcessorCount, 8).ToString(), "--host", "127.0.0.1", "--port", port.ToString() })
                psi.ArgumentList.Add(a);
            proc = Process.Start(psi) ?? throw new Exception("start failed");
            proc.OutputDataReceived += (_, _) => { };
            proc.ErrorDataReceived += (_, _) => { };
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            ChildJob.Add(proc);
            baseUrl = $"http://127.0.0.1:{port}";
            // Load the model, then one request (which also builds the CUDA
            // kernels on a new driver) before anyone waits on it.
            var silent = Wav.Encode(new float[16000], 16000);
            var deadline = DateTime.Now.AddSeconds(120);
            while (true)
            {
                if (proc.HasExited) throw new Exception($"exited {proc.ExitCode}");
                try
                {
                    Post(silent, TimeSpan.FromSeconds(20));
                    return;
                }
                catch when (DateTime.Now < deadline)
                {
                    Thread.Sleep(300);
                }
            }
        }

        static string Post(byte[] wav, TimeSpan timeout)
        {
            using var form = new MultipartFormDataContent();
            form.Add(new ByteArrayContent(wav), "file", "clip.wav");
            form.Add(new StringContent("text"), "response_format");
            form.Add(new StringContent("ko"), "language");
            using var cts = new CancellationTokenSource(timeout);
            var res = http.PostAsync(baseUrl + "/inference", form, cts.Token).GetAwaiter().GetResult();
            var body = res.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            if (!res.IsSuccessStatusCode) throw new Exception($"HTTP {(int)res.StatusCode}: {body.Trim()}");
            return body;
        }

        public static string Transcribe(byte[] wav)
        {
            if (State is "starting") throw new Exception("음성 인식을 준비하고 있어요");
            if (State is "off") throw new Exception("음성 인식을 시작하지 못했어요");
            one.Wait();
            try
            {
                return Clean(Post(wav, TimeSpan.FromMinutes(2)));
            }
            finally
            {
                one.Release();
            }
        }

        // Clean joins whisper's lines and drops what it makes up for silence —
        // the same rules as the desktop app's cleanTranscript (desktop/voice.go).
        static readonly Regex BracketNote = new(@"\[[^\]]*\]|\([^)]{0,10}\)");
        static readonly Regex NewsSignoff = new(@"(MBC|KBS|SBS|YTN|JTBC)\s*뉴스\s*\S{0,6}(입니다|였습니다)[.!]?");
        static readonly string[] Hallucinations = { "감사합니다", "시청해주셔서 감사합니다", "시청해 주셔서 감사합니다", "구독과 좋아요 부탁드립니다", "MBC 뉴스" };

        static string Clean(string s)
        {
            s = BracketNote.Replace(s, " ");
            s = NewsSignoff.Replace(s, " ");
            s = Regex.Replace(s, @"\s+", " ").Trim();
            foreach (var p in s.Split(new[] { '.', '!', '?', ',', '-' }))
                if (p.Trim().Length > 0 && Array.IndexOf(Hallucinations, p.Trim()) < 0) return s;
            return "";
        }

        public static void Stop()
        {
            try
            {
                if (proc != null && !proc.HasExited) proc.Kill();
            }
            catch { }
            proc = null;
        }
    }

    // ChildJob kills whisper-server with the engine, however the engine ends.
    static class ChildJob
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string? name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref Limits info, int len);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

        [StructLayout(LayoutKind.Sequential)]
        struct Basic
        {
            public long a, b;
            public uint Flags;
            public UIntPtr c, d;
            public uint e;
            public UIntPtr f;
            public uint g, h;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct Limits
        {
            public Basic B;
            public long io1, io2, io3, io4, io5, io6;
            public UIntPtr m1, m2, m3, m4;
        }

        static IntPtr job;

        public static void Add(Process p)
        {
            if (job == IntPtr.Zero)
            {
                job = CreateJobObject(IntPtr.Zero, null);
                var l = new Limits();
                l.B.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                SetInformationJobObject(job, 9, ref l, Marshal.SizeOf<Limits>());
            }
            AssignProcessToJobObject(job, p.Handle);
        }
    }
}
