"use strict";
const test = require("node:test");
const assert = require("node:assert");
const T = require("../core/text");

test("parseCommand knows the voice commands and leaves requests alone", () => {
  assert.deepStrictEqual(T.parseCommand("여자 삼 번 목소리로 바꿔 줘"), { kind: "voice", name: "F3" });
  assert.deepStrictEqual(T.parseCommand("남자 목소리로 바꿔"), { kind: "voice", name: "M2" });
  assert.deepStrictEqual(T.parseCommand("다른 목소리로 바꿔 줘", "M2"), { kind: "voice", name: "M3" });
  assert.deepStrictEqual(T.parseCommand("좀 더 천천히 말해 줘"), { kind: "speed", delta: -0.1 });
  assert.deepStrictEqual(T.parseCommand("빨리 읽어 줘"), { kind: "speed", delta: 0.1 });
  assert.deepStrictEqual(T.parseCommand("속도 원래대로 해 줘"), { kind: "speed", delta: null });
  assert.deepStrictEqual(T.parseCommand("자세히 읽어 줘"), { kind: "read", mode: "full" });
  assert.deepStrictEqual(T.parseCommand("다시 읽어 줘"), { kind: "read", mode: "" });
  assert.deepStrictEqual(T.parseCommand("글로만 보여 줘"), { kind: "textOnly", on: true });
  assert.deepStrictEqual(T.parseCommand("다시 말로 해 줘"), { kind: "textOnly", on: false });
  assert.deepStrictEqual(T.parseCommand("목소리 등록해 줘"), { kind: "enroll" });
  assert.deepStrictEqual(T.parseCommand("목소리 등록 해제해 줘"), { kind: "unenroll" });
  assert.deepStrictEqual(T.parseCommand("새 대화 시작해 줘"), { kind: "newConversation" });
  assert.deepStrictEqual(T.parseCommand("잠깐"), { kind: "hush" });
  assert.deepStrictEqual(T.parseCommand("부르는 이름을 자비스로 바꿔 줘"), { kind: "wakeName", set: true, name: "자비스" });
  assert.strictEqual(T.parseCommand("음성 인식 모델을 small에서 medium으로 바꿔 줘"), null);
  assert.strictEqual(T.parseCommand("이 함수 이름 바꿔 줘"), null);
  assert.strictEqual(T.parseCommand("테스트 돌려 줘"), null);
});

test("wakeMatch finds the name at the start, however Whisper writes it", () => {
  for (const s of ["아글링크", "아그링크~ 오늘", "어글링크야", "아글랭크 뭐해", "음 아글링크"]) assert.ok(T.wakeMatch(s) >= 0, s);
  assert.strictEqual(T.wakeMatch("그건 회사에서 아글링크를 쓰는 사람이"), -1);
  assert.strictEqual(T.wakeMatch("자비스 불 켜", { wakeDefault: false, wakeNames: ["자비스"] }), 3);
  assert.strictEqual(T.wakeMatch("아글링크", { wakeDefault: false, wakeNames: ["자비스"] }), -1);
});

test("speechText reads the point, not the code, tables or links", () => {
  const md = "네.\n\n버그를 고쳤어요. 테스트도 통과했어요.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```go\nfunc main() {}\n```\n\n- **고친 것:** `foo.go` 의 경계 조건이에요.\n- [링크](http://x)\n\n배포할까요?";
  const s = T.speechText(md, "short");
  assert.match(s, /버그를 고쳤어요/);
  assert.match(s, /배포할까요\?$/);
  assert.doesNotMatch(s, /func|foo\.go|http|\|/);
});

test("isEcho tells our own reading heard back from the user's words", () => {
  const reply = "여섯 군데를 고쳤어요. 테스트는 모두 통과했어요.";
  assert.ok(T.isEcho("테스트는 모두 통과했어요", reply));
  assert.ok(T.isEcho("6군대를 고쳤어요", reply));
  assert.ok(!T.isEcho("그럼 배포해 줘", reply));
  assert.ok(T.isEcho("엠투 목소리", "M2 목소리로 바꿨어요"));
});
