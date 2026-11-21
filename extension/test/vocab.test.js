"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const V = require("../core/vocab");

const vocab = () =>
  V.compile(
    V.tidy({
      words: ["Headscale", "두원"],
      replace: [
        { from: "에이지링크", to: "aglink" },
        { from: "아그링크", to: "aglink" },
        { from: "에이지", to: "AG" },
        { from: "head scale", to: "Headscale" },
        { from: "ai", to: "AI" },
      ],
      snippets: [
        { trigger: "내 메일 주소", text: "doowon@example.com" },
        { trigger: "서명 넣어", text: "감사합니다.\r\n두원 드림" },
      ],
    }),
  );

// The same cases as desktop/vocab_test.go: both apps must treat the file alike.
test("replacements ignore spaces and case, prefer the longest phrase and respect Latin word edges", () => {
  const v = vocab();
  const cases = {
    "에이지링크 켜 줘": "aglink 켜 줘",
    "에이지 링크를 설치해": "aglink를 설치해",
    "아그링크, 에이지 버전": "aglink, AG 버전",
    "HEAD SCALE 서버": "Headscale 서버",
    "ai 로 정리해 줘": "AI 로 정리해 줘",
    "he said hi": "he said hi",
    "그냥 아무 말": "그냥 아무 말",
    "": "",
    "에이지링크에이지링크": "aglinkaglink",
    "aglink 은 그대로 둬 줘": "aglink 은 그대로 둬 줘",
  };
  for (const [input, want] of Object.entries(cases)) assert.strictEqual(v.expand(v.fix(input)), want, input);
});

test("a snippet's trigger becomes its text; said alone, only the text", () => {
  const v = vocab();
  const cases = {
    "내 메일 주소.": "doowon@example.com",
    "내메일주소": "doowon@example.com",
    " 서명 넣어! ": "감사합니다.\n두원 드림",
    "내 메일 주소 알려 줘": "doowon@example.com 알려 줘",
    "여기에 서명 넣어 줘": "여기에 감사합니다.\n두원 드림 줘",
    "메일 주소는 따로 있어": "메일 주소는 따로 있어",
    "에이지링크 내 메일 주소 보내": "aglink doowon@example.com 보내",
  };
  for (const [input, want] of Object.entries(cases)) assert.strictEqual(v.expand(v.fix(input)), want, input);
  assert.strictEqual(v.fix("내 메일 주소"), "내 메일 주소", "fix leaves the snippets for sending");
});

test("tidy drops blanks and repeats; the prompt is the words, short, or nothing", () => {
  const v = V.tidy({ words: [" 두원 ", "", "두 원", "Headscale", "headscale"], replace: [{ from: " ", to: "x" }, { from: "A", to: "1" }, { from: "a", to: "2" }], snippets: [{ trigger: "서명.", text: "a\r\nb" }, { trigger: "빈 것", text: " " }], extra: 1 });
  assert.deepStrictEqual(v, { words: ["두원", "Headscale"], replace: [{ from: "A", to: "1" }], snippets: [{ trigger: "서명", text: "a\nb" }] });
  assert.strictEqual(V.compile(v).prompt, "두원, Headscale.");
  assert.strictEqual(V.compile(V.tidy(null)).prompt, "");
  const long = V.compile(V.tidy({ words: Array.from({ length: 40 }, (_, i) => `가가가가가${i}`) }));
  assert.ok(long.prompt.length <= V.MAX_PROMPT_CHARS + 1, long.prompt);
});

test("the prompt's words read back are dropped, a request using some of them is not", () => {
  const words = ["Headscale", "두원", "나스"];
  assert.ok(V.isPromptEcho("Headscale, 두원, 나스.", words));
  assert.ok(!V.isPromptEcho("Headscale, 두원 서버 켜 줘, 나스.", words));
  assert.ok(!V.isPromptEcho("두원, 나스.", words));
});

test("the file is read again when it changes; missing or broken means no vocabulary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocab-"));
  const file = path.join(dir, V.VOCAB_FILE);
  const logs = [];
  const vs = V.createVocab({ file, log: (m) => logs.push(m) });
  assert.strictEqual(vs.current().fix("에이지링크"), "에이지링크");
  V.ensureVocabFile(file);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { words: [], replace: [], snippets: [] });
  fs.writeFileSync(file, "\uFEFF" + JSON.stringify({ replace: [{ from: "에이지링크", to: "aglink" }] }));
  assert.strictEqual(vs.current().fix("에이지링크 열어"), "aglink 열어");
  fs.writeFileSync(file, JSON.stringify({ replace: [{ from: "아그링크", to: "AG" }] }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.strictEqual(vs.current().fix("아그링크 에이지링크"), "AG 에이지링크");
  fs.writeFileSync(file, "{broken");
  assert.strictEqual(vs.current().fix("아그링크"), "아그링크");
  assert.strictEqual(logs.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(vs.current().fix("아그링크"), "아그링크");
  assert.strictEqual(V.vocabPath({ AGLINK_HOME: " D:/home " }), path.join("D:/home", V.VOCAB_FILE));
});
