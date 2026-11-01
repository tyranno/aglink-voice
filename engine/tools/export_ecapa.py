# Exports SpeechBrain's ECAPA-TDNN (VoxCeleb) voice embedding, Fbank front end
# included, to ONNX, so the standalone voice engine tells the enrolled voice
# from others without Python. Input: 16 kHz mono float samples [1, N]; output:
# the 192-d embedding [1, 192]. Checks the ONNX scores against PyTorch's.
#   python export_ecapa.py <ecapa dir> <out.onnx> [test wavs...]
import sys

import numpy as np
import onnxruntime as ort
import torch
import torchaudio
from speechbrain.lobes.features import Fbank
from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN


N_FFT, HOP = 400, 160


class Embedder(torch.nn.Module):
    """Fbank + ECAPA. The STFT is a strided convolution with the windowed DFT
    as its kernel: the same numbers as SpeechBrain's torch.stft (centered,
    zero padded, Hamming), but made of ops ONNX exports."""

    def __init__(self, ckpt):
        super().__init__()
        self.fbank = Fbank(n_mels=80)
        win = torch.hamming_window(N_FFT)
        n = torch.arange(N_FFT, dtype=torch.float64)
        k = torch.arange(N_FFT // 2 + 1, dtype=torch.float64)[:, None]
        ang = 2 * torch.pi * k * n / N_FFT
        kern = torch.cat([torch.cos(ang), -torch.sin(ang)]).float() * win
        self.register_buffer("dft", kern[:, None, :])
        self.model = ECAPA_TDNN(
            input_size=80,
            channels=[1024, 1024, 1024, 1024, 3072],
            kernel_sizes=[5, 3, 3, 3, 1],
            dilations=[1, 2, 3, 4, 1],
            attention_channels=128,
            lin_neurons=192,
        )
        self.model.load_state_dict(torch.load(ckpt, map_location="cpu", weights_only=True))

    def forward(self, wav):
        x = torch.nn.functional.pad(wav[:, None, :], (N_FFT // 2, N_FFT // 2))
        y = torch.nn.functional.conv1d(x, self.dft, stride=HOP)
        re, im = y[:, : N_FFT // 2 + 1], y[:, N_FFT // 2 + 1 :]
        power = (re * re + im * im).transpose(1, 2)
        feats = self.fbank.compute_fbanks(power)
        feats = feats - feats.mean(dim=1, keepdim=True)
        return self.model(feats).squeeze(1)


def load(path):
    wav, rate = torchaudio.load(path)
    wav = wav.mean(0, keepdim=True)
    if rate != 16000:
        wav = torchaudio.functional.resample(wav, rate, 16000)
    return wav


def main():
    src, out, tests = sys.argv[1], sys.argv[2], sys.argv[3:]
    m = Embedder(f"{src}/embedding_model.ckpt").eval()
    x = torch.randn(1, 32000) * 0.1
    with torch.no_grad():
        torch.onnx.export(
            m, (x,), out, input_names=["wav"], output_names=["embedding"],
            dynamic_axes={"wav": {1: "samples"}}, opset_version=17, dynamo=False,
        )
    sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    embs = []
    for p in tests:
        w = load(p)
        with torch.no_grad():
            a = m(w)[0]
            ref = m.fbank(w)
            ref = ref - ref.mean(dim=1, keepdim=True)
            a0 = m.model(ref).squeeze()
        print(f"{p}: conv STFT vs SpeechBrain cosine {torch.nn.functional.cosine_similarity(a, a0, dim=0).item():.5f}")
        b = torch.from_numpy(sess.run(None, {"wav": w.numpy()})[0][0])
        embs.append((a, b))
        print(f"{p}: torch vs onnx cosine {torch.nn.functional.cosine_similarity(a, b, dim=0).item():.5f}")
    for i in range(len(embs)):
        for j in range(i + 1, len(embs)):
            t = torch.nn.functional.cosine_similarity(embs[i][0], embs[j][0], dim=0).item()
            o = torch.nn.functional.cosine_similarity(embs[i][1], embs[j][1], dim=0).item()
            print(f"score {i}-{j}: torch {t:.4f} onnx {o:.4f}")


if __name__ == "__main__":
    main()
