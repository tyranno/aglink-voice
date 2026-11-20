// A stand-in for aglink-voice-engine.exe in engine.test.js, run as
// `node fake-engine.js <root> ...` (Engine passes its root first). The
// AGLINK_FAKE_ENGINE variable picks how it behaves:
//   silent — never says "ready" (and never exits by itself)
//   ok     — says "ready", answers every request except op "hang"
"use strict";

const mode = process.env.AGLINK_FAKE_ENGINE || "ok";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");

setInterval(() => {}, 1 << 30); // stay up until killed or stdin closes

if (mode === "ok") {
  out({ ev: "ready" });
  let buf = "";
  process.stdin.setEncoding("utf8").on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (req.op !== "hang") out({ id: req.id, ok: true, op: req.op });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
