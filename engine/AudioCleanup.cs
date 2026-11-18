using System;
using NAudio.Dsp; // BiQuadFilter

// AudioCleanup tidies a recorded clip before it goes to whisper: a high-pass to
// drop low rumble/hum, conservative spectral-subtraction noise suppression, and
// AGC to bring far-field speech to a steady level. It NEVER breaks the turn — any
// problem returns the original wav unchanged.
//
// level: "off" (passthrough) | "light" (this pure-C# chain) | "strong"
// (RNNoise when added; falls back to the light chain until then).
namespace AglinkVoice
{

static class AudioCleanup
{
    public static byte[] Process(byte[] wav, string level)
    {
        if (string.IsNullOrWhiteSpace(level) || level == "off") return wav;
        try
        {
            float[] x = Wav.Decode16k(wav);
            if (x.Length < 1024) return wav; // too short to help; leave it
            HighPass(x, 16000, 90f);
            SpectralSubtract(x);
            Agc(x);
            return Wav.Encode(x, 16000);
        }
        catch
        {
            return wav; // recognition must never fail because of cleanup
        }
    }

    static void HighPass(float[] x, int rate, float cutoff)
    {
        var f = BiQuadFilter.HighPassFilter(rate, cutoff, 0.707f);
        for (int i = 0; i < x.Length; i++) x[i] = f.Transform(x[i]);
    }

    // Conservative spectral subtraction with 50%-overlap Hann STFT. The noise
    // magnitude per bin is the 10th percentile across frames (the quiet floor);
    // oversubtraction alpha and a spectral floor beta keep speech intact and
    // avoid musical noise.
    static void SpectralSubtract(float[] x)
    {
        const int N = 512, hop = 256;
        const double alpha = 1.5, beta = 0.08;
        int frames = (x.Length - N) / hop + 1;
        if (frames < 4) return;

        var win = new double[N];
        for (int i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (N - 1));

        var re = new double[frames][];
        var im = new double[frames][];
        var mags = new double[N / 2 + 1][];
        for (int b = 0; b <= N / 2; b++) mags[b] = new double[frames];

        for (int t = 0; t < frames; t++)
        {
            var fr = new double[N];
            var fi = new double[N];
            int off = t * hop;
            for (int i = 0; i < N; i++) fr[i] = x[off + i] * win[i];
            Fft(fr, fi, false);
            re[t] = fr; im[t] = fi;
            for (int b = 0; b <= N / 2; b++) mags[b][t] = Math.Sqrt(fr[b] * fr[b] + fi[b] * fi[b]);
        }

        var noise = new double[N / 2 + 1];
        for (int b = 0; b <= N / 2; b++)
        {
            var v = (double[])mags[b].Clone();
            Array.Sort(v);
            noise[b] = v[Math.Max(0, frames / 10)];
        }

        var outp = new double[x.Length];
        var wsum = new double[x.Length];
        for (int t = 0; t < frames; t++)
        {
            var fr = re[t]; var fi = im[t];
            for (int b = 0; b <= N / 2; b++)
            {
                double m = Math.Sqrt(fr[b] * fr[b] + fi[b] * fi[b]);
                double g = m <= 1e-12 ? 0 : Math.Max(beta, (m - alpha * noise[b]) / m);
                fr[b] *= g; fi[b] *= g;
                if (b > 0 && b < N / 2) { int c = N - b; fr[c] = fr[b]; fi[c] = -fi[b]; } // keep conjugate symmetry
            }
            Fft(fr, fi, true);
            int off = t * hop;
            for (int i = 0; i < N; i++) { outp[off + i] += fr[i] * win[i]; wsum[off + i] += win[i] * win[i]; }
        }
        for (int i = 0; i < x.Length; i++)
            if (wsum[i] > 1e-9) x[i] = (float)(outp[i] / wsum[i]);
    }

    // AGC: normalise RMS to a target with a hard limiter. Capped gain so near
    // silence is not blown up into noise.
    static void Agc(float[] x)
    {
        double sum = 0;
        for (int i = 0; i < x.Length; i++) sum += (double)x[i] * x[i];
        double rms = Math.Sqrt(sum / Math.Max(1, x.Length));
        if (rms < 1e-5) return;
        const double target = 0.12;
        double gain = Math.Min(target / rms, 8.0);
        for (int i = 0; i < x.Length; i++)
        {
            double v = x[i] * gain;
            x[i] = (float)(v > 0.98 ? 0.98 : v < -0.98 ? -0.98 : v);
        }
    }

    // In-place iterative radix-2 Cooley-Tukey FFT. inverse=true divides by n.
    // Length must be a power of two.
    static void Fft(double[] re, double[] im, bool inverse)
    {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++)
        {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { (re[i], re[j]) = (re[j], re[i]); (im[i], im[j]) = (im[j], im[i]); }
        }
        for (int len = 2; len <= n; len <<= 1)
        {
            double ang = 2 * Math.PI / len * (inverse ? 1 : -1);
            double wr = Math.Cos(ang), wi = Math.Sin(ang);
            for (int i = 0; i < n; i += len)
            {
                double cr = 1, ci = 0;
                for (int k = 0; k < len / 2; k++)
                {
                    int a = i + k, b = a + len / 2;
                    double tr = re[b] * cr - im[b] * ci;
                    double ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                    double ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr; cr = ncr;
                }
            }
        }
        if (inverse)
            for (int i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
}
}
