# aglink-voice 마이크 전처리(노이즈·잔향 완화) 설계

작성 2026-11-18.

## 의도 (why)
사용자 방이 **잔향(에코)이 심하고 주변 노이즈가 많음**, 입력이 **원거리 USB 스피커폰**.
whisper로 보내기 **전에** 오디오를 소프트웨어로 정리해 인식 정확도를 올린다.
근본 해결(근접 헤드셋 마이크)은 별개로 두고, 지금 환경에서 가능한 SW 개선을 제공한다.

## 목표 / 비목표
- 목표: 녹음된 클립(16 kHz mono PCM)을 whisper `/inference` 로 보내기 직전에
  **고역통과 + 노이즈 억제 + AGC(레벨 정규화)** 로 정리. 설정으로 강도 선택.
- 비목표: **AEC(재생음 되들어옴 제거)는 하지 않음** — 사용자 확인: 읽어주는 소리가
  마이크로 되들어오는 상황이 아님.
- 비목표: 완전한 잔향제거(WPE dereverb) — C#에서 비현실적. 고역통과/게이트로 **부분 완화**만.

## 접근 (사용자 선택: 둘 다 넣고 설정에서 고름)
설정 `aglinkVoice.micCleanup`: `"off"`(기본) | `"light"`(순수 C#) | `"strong"`(RNNoise).
- **off**: 기존과 동일(전처리 없음). 기본값이라 아무 것도 안 깨짐.
- **light**: 순수 C# DSP, 새 바이너리 의존성 0.
  1. 고역통과 ~90 Hz (저주파 웅웅/전원 험 제거)
  2. 스펙트럴 서브트랙션/Wiener 기반 노이즈 억제 (클립 앞 ~200 ms를 노이즈 추정에 사용)
  3. AGC: 피크/RMS를 목표 레벨로 정규화
- **strong**: RNNoise(Xiph, 오픈소스 신경망 denoise) + 고역통과 + AGC.
  - RNNoise는 48 kHz/480샘플 프레임 네이티브 → 16k→48k 업샘플 → RNNoise → 16k 다운샘플.
  - win-x64 `rnnoise.dll` 을 엔진 폴더에 번들, P/Invoke. dll 없으면 **light 로 자동 폴백**(안전).

## 적용 위치
C# 엔진 `Whisper.Transcribe(wav)` 진입부(또는 clip 조립 직후), `/inference` POST 직전.
전처리 함수 `AudioCleanup.Process(pcm16k, level)` 신설. 실패 시 **원본 그대로 통과**(절대 턴을 깨지 않음).

## 설정 전달
확장이 `aglinkVoice.micCleanup` 를 읽어 엔진 spawn 때 `--mic-cleanup=<off|light|strong>` 인자로 전달
(whisperServer 와 동일 패턴). 설정화면(settingsPanel)·package.json 에 항목 추가.

## 검증
- 같은 녹음 클립을 off/light/strong 으로 각각 전사해 정확도 비교(before/after).
- 과도한 억제로 말소리까지 깎이지 않는지(AGC 클리핑, musical noise) 확인.
- dll 없을 때 strong→light 폴백 확인.

## 단계
1. light(순수 C#) + 설정/인자 배선 + off 기본 → 빌드·설치·측정.
2. 효과 확인 후 strong(RNNoise dll 번들) 추가.
