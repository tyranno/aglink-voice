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

test("a summary takes a point from every paragraph, not just the first one", () => {
  const md = "엔진을 고쳤어요. 빌드도 끝났어요. 시험도 했어요.\n\n원인은 읽기 속도였어요. 빠르면 말을 삼켜요.\n\n그래서 보통 속도로 만들고 빠르기만 올렸어요. 음 높이는 그대로예요.\n\n다시 켜 주세요.";
  const s = T.speechText(md, "short");
  assert.match(s, /엔진을 고쳤어요/);
  assert.match(s, /원인은 읽기 속도였어요/);
  assert.match(s, /보통 속도로 만들고/);
  assert.match(s, /다시 켜 주세요/);
  assert.doesNotMatch(s, /빠르면 말을 삼켜요|음 높이는/);
});

test("a sentence that announces points is read with the points it announces", () => {
  const md = "올렸어요. 상태도 같아요.\n\n알아 두실 점이 두 가지 있어요. 하나는 테스트 두 개가 실패한다는 거예요. 그건 원래 그랬어요. 다른 하나는 파일을 직접 복사했다는 거예요. 다시 설치하면 덮어써져요.\n\n고친 것은 이래요. 엔진이에요. 확장이에요. 문서예요.";
  const s = T.speechText(md, "short");
  assert.match(s, /두 가지 있어요\. 하나는 테스트 두 개가 실패한다는 거예요\. 다른 하나는 파일을 직접 복사했다는 거예요\./);
  assert.doesNotMatch(s, /원래 그랬어요|덮어써져요|문서예요/);
  assert.match(s, /이래요\. 엔진이에요\. 확장이에요\./);
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

test("a dialogue is told by its speaker dashes, with or without a space after them", () => {
  const turns = (s) => (s.match(T.DIALOGUE_RE) || []).length;
  assert.strictEqual(turns("- 그쵸. - 네."), 2);
  assert.strictEqual(turns("-뭐가 있는가? -뭐가 있는가?"), 2);
  assert.strictEqual(turns("-아기가 스냅금 친다면서. -네. -그럴 것 같은데."), 3);
  assert.strictEqual(turns("메일은 e-mail 로 보내 줘"), 0, "a hyphen inside a word");
  assert.strictEqual(turns("내일은 -5도래"), 0, "a minus sign");
  assert.strictEqual(turns("3-4시 사이에 회의"), 0);
});

test("wakePrompt lists the wake names to prime recognition", () => {
  assert.strictEqual(T.wakePrompt({ wakeDefault: true, wakeNames: [] }), "아글링크");
  assert.strictEqual(T.wakePrompt({ wakeDefault: true, wakeNames: ["길동이"] }), "아글링크, 길동이");
  assert.strictEqual(T.wakePrompt({ wakeDefault: false, wakeNames: ["길동이"] }), "길동이");
});

test("splitAddressee: a question said to Codex or Claude by name goes to it, a mention does not", () => {
  const cases = {
    "코덱스한테 이 버그 고쳐 줘": { agent: "codex", text: "이 버그 고쳐 줘" },
    "코덱스 한테, 테스트 돌려 봐": { agent: "codex", text: "테스트 돌려 봐" },
    "코덱스야 빌드해 줘": { agent: "codex", text: "빌드해 줘" },
    "Codex, run tests": { agent: "codex", text: "run tests" },
    "클로드한테 커밋해 줘": { agent: "claude", text: "커밋해 줘" },
    "클로드 코드에게 리뷰해 줘": { agent: "claude", text: "리뷰해 줘" },
    "클로드야, 로그 봐 줘": { agent: "claude", text: "로그 봐 줘" },
    "이 파일 정리해 줘 라고 코덱스한테 전해 줘": { agent: "codex", text: "이 파일 정리해 줘" },
    "테스트 돌려 달라고 코덱스한테 말해 줘": { agent: "codex", text: "테스트 돌려 달라고" },
  };
  for (const [said, want] of Object.entries(cases)) assert.deepStrictEqual(T.splitAddressee(said), want, said);
  for (const said of ["코덱스 설정 열어 줘", "코덱스는 어떻게 생각해", "코덱스로 바꿔 줘", "코덱스한테", "오늘 날씨 어때", ""])
    assert.strictEqual(T.splitAddressee(said), null, said);
});
