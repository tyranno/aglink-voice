using System;
using System.IO;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;

namespace AglinkVoice
{
    // Silero VAD v5 (models/silero_vad.onnx): a speech probability for 16 kHz
    // mono audio, used to tell the user's voice from room noise more reliably
    // than loudness alone. Stateful — the model's LSTM state carries between its
    // 512-sample windows, so one run of the mic is one stream; Reset() begins a
    // fresh stream so one utterance's state does not bleed into the next.
    //
    // Model I/O (read off the file): input float32[1,N], state float32[2,1,128],
    // sr int64 (scalar); outputs output float32[1,1] (the probability) and
    // stateN float32[2,1,128] (the next state). It runs in fixed 512-sample
    // steps (~32 ms at 16 kHz); mic pieces are buffered to that size.
    //
    // Everything here is non-throwing: on a missing model or any runtime error
    // it disables itself and returns 0, so the mic path keeps working without it.
    static class Vad
    {
        const int Window = 512; // samples per Silero step at 16 kHz

        const int Context = 64; // samples of the previous window prepended to each run

        static InferenceSession? sess;
        static bool failed;
        static readonly float[] state = new float[2 * 1 * 128];
        static readonly float[] ctx = new float[Context]; // last 64 samples of the previous window
        static readonly short[] buf = new short[Window];
        static int have; // samples buffered toward the next window
        static readonly object mu = new();

        static InferenceSession? Session()
        {
            if (sess != null || failed) return sess;
            try
            {
                var path = Path.Combine(Engine.Root, "models", "silero_vad.onnx");
                if (!File.Exists(path)) { failed = true; return null; }
                sess = new InferenceSession(path);
                return sess;
            }
            catch (Exception ex)
            {
                failed = true;
                Engine.Send(new { ev = "vad", error = ex.Message });
                return null;
            }
        }

        // Reset clears the LSTM state and any partial window. Call it when the
        // mic (re)starts so a new utterance begins from silence.
        public static void Reset()
        {
            lock (mu) { Array.Clear(state, 0, state.Length); Array.Clear(ctx, 0, ctx.Length); have = 0; }
        }

        // Prob feeds s16 mono 16 kHz samples and returns the highest speech
        // probability over the Silero windows that completed inside them. It is
        // 0 when the model is absent, or when no window has filled yet (the first
        // few short pieces of a stream): callers treat 0 as "no speech detected".
        public static float Prob(byte[] pcm, int offset, int count)
        {
            var s = Session();
            if (s == null) return 0f;
            try
            {
                lock (mu)
                {
                    float best = -1f;
                    int n = count / 2;
                    for (int i = 0; i < n; i++)
                    {
                        buf[have++] = (short)(pcm[offset + i * 2] | (pcm[offset + i * 2 + 1] << 8));
                        if (have < Window) continue;
                        have = 0;
                        best = Math.Max(best, Run(s));
                    }
                    return best < 0 ? 0f : best;
                }
            }
            catch (Exception ex)
            {
                failed = true;
                sess = null;
                Engine.Send(new { ev = "vad", error = ex.Message });
                return 0f;
            }
        }

        static float Run(InferenceSession s)
        {
            // Silero v5 runs on the 64-sample context of the previous window
            // followed by this window's 512 samples (the wrapper, not the model,
            // carries the context; feeding only 512 gives near-zero on real
            // speech). Samples are scaled to [-1, 1].
            var input = new float[Context + Window];
            for (int i = 0; i < Context; i++) input[i] = ctx[i];
            for (int i = 0; i < Window; i++) input[Context + i] = buf[i] / 32768f;

            var feeds = new[]
            {
                NamedOnnxValue.CreateFromTensor("input", new DenseTensor<float>(input, new[] { 1, Context + Window })),
                NamedOnnxValue.CreateFromTensor("state", new DenseTensor<float>(state, new[] { 2, 1, 128 })),
                NamedOnnxValue.CreateFromTensor("sr", new DenseTensor<long>(new long[] { 16000 }, new[] { 1 })),
            };

            using var res = s.Run(feeds);
            float prob = 0f;
            foreach (var r in res)
            {
                if (r.Name == "output") prob = r.AsTensor<float>().GetValue(0);
                else if (r.Name == "stateN")
                {
                    var t = r.AsTensor<float>();
                    for (int i = 0; i < state.Length; i++) state[i] = t.GetValue(i);
                }
            }
            for (int i = 0; i < Context; i++) ctx[i] = input[Window + i]; // last 64 of this window
            return prob;
        }
    }
}
