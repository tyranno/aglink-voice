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

test("the user's own end words end the conversation, alone or with a short tail", () => {
  const s = { stopDefault: false, stopWords: ["됐어", "끝", "Bye"] };
  for (const t of ["됐어", "됐어요.", "끝", "끝이야!", "bye"]) assert.ok(T.stopMatch(t, s), t);
  for (const t of ["그만", "안 끝", "끝까지 읽어 줘", "그거 됐어 그럼 다음 거 해 줘", "됐어 이제 커밋해 줘"]) assert.ok(!T.stopMatch(t, s), t);
  assert.ok(T.stopMatch("그만", { stopDefault: true, stopWords: ["끝"] }));
  assert.ok(T.stopMatch("그만해", { stopDefault: false, stopWords: [] }), "never left without a way to end");
  assert.deepStrictEqual(T.cleanWakeNames(["끝", " Hey Jarvis ", "자비스"], 1), ["끝", "HeyJarvis", "자비스"]);
});

test("wake names in another language", () => {
  assert.ok(T.wakeMatch("Hey Jarvis, 오늘 일정", { wakeDefault: false, wakeNames: ["HeyJarvis"] }) >= 0);
  assert.ok(T.wakeMatch("자비스 오늘 일정", { wakeDefault: false, wakeNames: ["Jarvis", "자비스"] }) >= 0);
});

test("pause, resume and mic-off are their own commands; a bare 멈춰 still stops the reading", () => {
  for (const s of ["인식 멈춰", "인식 멈춰.", "음성 인식 멈춰 줘", "인식 중지", "듣기 그만", "받아쓰기 멈춰"]) assert.deepStrictEqual(T.parseCommand(s), { kind: "pause" }, s);
  for (const s of ["다시 인식해", "다시 인식해 줘.", "다시 들어", "인식 다시 시작해", "인식 재개해"]) assert.deepStrictEqual(T.parseCommand(s), { kind: "resume" }, s);
  for (const s of ["마이크 꺼", "마이크 꺼 줘.", "음성 꺼", "마이크를 꺼라"]) assert.deepStrictEqual(T.parseCommand(s), { kind: "micOff" }, s);
  assert.deepStrictEqual(T.parseCommand("멈춰"), { kind: "hush" }, "bare 멈춰 still stops the reading");
  // Mentioning them in a request still goes to Claude Code.
  for (const s of ["인식 멈춰 버튼을 화면에 추가해 줘", "마이크 꺼지는 버그 고쳐 줘", "다시 인식해서 정리해 줘"]) assert.strictEqual(T.parseCommand(s), null, s);
});
