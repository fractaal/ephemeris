# Models

`beat_this-small0.onnx`: [Beat This!](https://github.com/CPJKU/beat_this) (Foscarin, Schlüter and Widmer, "Beat this! Accurate beat tracking without DBN postprocessing", ISMIR 2024), its small model (`small0`), as tools/music.mjs runs it: beats and downbeats from a song's log-mel spectrogram, 50 frames a second, in 30 s chunks. MIT licensed, the weights as the code (LICENSE-beat_this).

Exported from the published checkpoint (beat_this 1.1.0, torch 2.14) with:

```python
from beat_this.inference import load_model
torch.onnx.export(load_model('small0'), (torch.randn(1, 1500, 128),), 'beat_this-small0.onnx',
                  input_names=['spect'], output_names=['beat', 'downbeat'],
                  dynamic_axes={'spect': {1: 'time'}, 'beat': {1: 'time'}, 'downbeat': {1: 'time'}}, opset_version=17, dynamo=False)
```

Checked against the package itself: its logits within 5e-6 of PyTorch's, and on the same waveform the same beats and downbeats, every one (tools/music.mjs makes the package's spectrogram to within 1e-4).

`basic_pitch-icassp_2022.onnx`: [Basic Pitch](https://github.com/spotify/basic-pitch) (Bittner et al., "A Lightweight Instrument-Agnostic Model for Polyphonic Note Transcription and Multipitch Estimation", ICASSP 2022), as tools/pitch.mjs runs it: note, onset and pitch-contour activations (88 keys from A0, 86 frames a second) from 2 s windows of mono audio at 22050 Hz. Apache-2.0, code and weights (LICENSE-basic_pitch, NOTICE-basic_pitch). The file is Spotify's own export, `basic_pitch/saved_models/icassp_2022/nmp.onnx` (last changed in dfb20ef, as in 0.4.0; 230 KB, sha256 2c3c1d14…). Its windowing and note-making (output_to_notes_polyphonic, with inferred onsets and the melodia trick) are ported from basic_pitch 0.4.0 as they are.

Checked against basic-pitch 0.4.0 itself (its ONNX model, default thresholds) on a vocal loop, an electric piano loop, a guitar chord loop and a 3:54 song: 27 of 27, 60 of 61, 44 of 44 and 1380 of 1417 of its notes found with the same pitch and an onset within 50 ms (the median the same frame; the rest near its thresholds, where ffmpeg's resampling and librosa's differ). 0.2–0.4 s a loop, 2.7 s the song, on the CPU.

## Downloaded once per machine

These are too large to ship. `tools/models.mjs` downloads each from its pinned URL into `~/.cache/ephemeris/models` the
first time it is used, and checks its sha256.

`depth-anything-v2-small`: [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2) (Yang et al., "Depth Anything V2", NeurIPS 2024), its small model (ViT-S, 25M parameters), as tools/depth.mjs runs it: relative depth (larger is nearer) from a photo whose shorter side is 518 px, each side a multiple of 14, normalized by ImageNet's mean and deviation. Apache-2.0, code and weights (the Base, Large and Giant models are CC-BY-NC-4.0 and do not qualify). The ONNX file is onnx-community's export ([onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small), `onnx/model.onnx` at commit 4472b73, 99 MB, sha256 afb6a5c2…).

Checked against the model in PyTorch (transformers, `depth-anything/Depth-Anything-V2-Small-hf`) on 17 night photos, from the same preprocessed input: its depth within 5.5e-5 of the depth range on onnxruntime's WebAssembly, within 1.3e-4 on WebGPU (an RTX 5070 Ti and a Radeon 890M). 0.1 s a photo on the 5070 Ti, 0.3 s on the 890M, 1.7 s on the CPU.

`big-lama`: [LaMa](https://github.com/advimman/lama) (Suvorov et al., "Resolution-robust Large Mask Inpainting with Fourier Convolutions", WACV 2022), its Big LaMa model, as tools/depth.mjs runs it: fills what a mask covers (1) in a 512 × 512 photo (0 … 1, RGB), from what is around it; its output is 0 … 255. Apache-2.0, code and weights. The ONNX file is Carve's export, with its Fourier convolutions written as matrix products ([Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX), `lama_fp32.onnx` at commit c3c0c9e, 208 MB, sha256 1faef530…). MI-GAN (MIT, 28 MB) does not do this job: on holes as large as a cut's (60–90 % of the photo) it fills with made-up rooms, where LaMa carries on the ground and what stands behind.

Checked against the published checkpoint in PyTorch (IOPaint's TorchScript of big-lama, `big-lama.pt`, sha256 344c77bb…) on a night photo with its cut's mask: within 0.02 of 255 on onnxruntime's WebAssembly and on WebGPU (an RTX 5070 Ti). 0.35 s a fill on the 5070 Ti, about 4 s on the CPU.
