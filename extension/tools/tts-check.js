// tts-check: reads sentences on the real engine and has Whisper write them
// back, so a broken reading (wrong text handling, gibberish) shows as text.
//
//   node extension/tools/tts-check.js <engine.exe> <root> ["sentence" ...]
"use strict";

const { Engine } = require("../core/engine");

const [exe, root, ...given] = process.argv.slice(2);
const sentences = given.length ? given : ["네, 저는 한국어로 쓰고 있어요.", "화면에 보이는 글자도 이상한가요?"];

(async () => {
  const engine = new Engine(exe, root, () => {});
  await engine.start();
  for (let i = 0; i < 60; i++) {
    const s = await engine.call("status", {});
    if (s.whisper === "gpu" || s.whisper === "cpu") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const text of sentences) {
    const { wav } = await engine.call("tts", { text, voice: "M2", speed: 0.98 });
    const back = await engine.call("transcribe", { wav });
    console.log(`${text}\n  → ${back.text}`);
  }
  engine.stop();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
