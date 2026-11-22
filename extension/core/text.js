// Words in and words out, with no audio and no VS Code: when a sentence has
// ended, whether it is a voice command, whether it is our own reading heard
// back through the speakers, whether it opens with the wake name, and what of
// a reply is worth reading aloud. Carried over from the aglink desktop app
// (desktop/frontend/src/voice.svelte.js) so both hear and read the same way.
"use strict";
const { speakNumbers } = require("./numbers");

const SENTENCE_END_RE = /(요|니다|죠)[.!?~]*$|(까|다|네|야|지|어|아|해|래|게|자|니|군|걸)[.!?~]+$/; // a finished Korean sentence
const GOES_ON_RE = /(니까|는데|는데요)[.~]*$/; // "그러니까…", "했는데…" lead into more
const CONV_STOP_RE = /^(그만|그만해|대화\s*(종료|끝)|음성\s*(대화\s*)?(종료|끝)|종료)[.!?\s]*$/;
const BARGE_HUSH_RE = /^(잠깐|잠깐만|잠시만|멈춰|스톱|stop|그만\s*읽어)[.!?\s]*$/i;
const BARGE_ON_RE = /^끼어들기\s*(켜|켜\s*줘|켜기|모드|on)[.!?\s]*$/i;
const BARGE_OFF_RE = /^(끼어들기\s*(꺼|꺼\s*줘|끄기|off)|주고\s*받기(\s*모드)?)[.!?\s]*$/i;
const ECHO_OVERLAP = 0.6; // share of a segment's syllable pairs found in the reply = our own voice
const ECHO_TRUST_MARGIN = 0.1; // this far over the voice bar is the user, whatever the words
const LISTEN_ALWAYS_RE = /^(항상|계속|늘)\s*(듣기|들어|들어\s*줘|켜\s*(둬|놔|놓아))(\s*(로|으로))?\s*(해|바꿔|해\s*줘|바꿔\s*줘|줘)?[.!?~\s]*$/;
const LISTEN_WAKE_RE = /^(호출어|부르기|부르면|아글링크\s*(로|하면))\s*(로|으로)?\s*(켜|켜기|시작|바꿔|해|하자)\S*(\s*줘)?[.!?~\s]*$/;
// "부르는 이름을 아그라로 바꿔 줘": a name of the user's own to wake on.
// A bare "이름을 …로 바꿔" is too often about something else, so "부르는" (or 호출어) is required.
const WAKE_NAME_SET_RE = /^(?:(?:부르는|호출|깨우는)\s*이름|호출어)\s*(을|를)?\s*["“']?(.{1,8}?)["”']?\s*(으로|로)\s*(바꿔|정해|해|지정해|설정해)\S*(\s*(줘|주세요))?[.!?~\s]*$/;
const WAKE_NAME_ADD_RE = /^["“']?(.{1,8}?)["”']?\s*(이)?라고\s*(불러도|해도|하면|부르면)\s*(알아들어|대답해|깨어나|켜져|켜)\S*(\s*(줘|주세요))?[.!?~\s]*$/;
const SPEAK_LIMITS = {
  short: { chars: 480, sentences: 2, points: 6 },
  gist: { chars: 800, sentences: 3, points: 8 },
};
const MAX_FULL_CHARS = 4000;
const CUT_MARGIN = 80; // a full reading this much longer than the summary means it was cut
const LIST_ITEM_RE = /^[ ]{0,1}([-*+]|\d+[.)])\s/;
const MIN_GIST_CHARS = 40; // a bare "네." opening pulls in the next paragraph
const TTS_VOICES = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"]; // Supertonic: male, female
const MAX_WAKE_NAMES = 5;
const MAX_NAME_LETTERS = 10; // "HeyJarvis" fits; spaces are left out

function clamp(v, [lo, hi]) {
  return Math.min(hi, Math.max(lo, v));
}

// cleanWakeNames keeps the user's own wake names: trimmed, 2–10 letters, no
// repeats. End words ("끝", "됐어") may be a single letter: minLetters 1.
function cleanWakeNames(list, minLetters = 2) {
  const out = [];
  for (const n of Array.isArray(list) ? list : []) {
    const name = String(n || "").replace(/[\s,.!?~"“”']/g, "");
    if (name.length >= minLetters && name.length <= MAX_NAME_LETTERS && !out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_WAKE_NAMES);
}

function normalizeForEcho(s) {
  return String(s || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// The reply is written with English words and digits, but whisper hears our
// voice reading them in Hangul ("OpenVoice" → "오픈 보이스", "M2" → "엠투"),
// so the echo check compares against how they are read aloud too.
const READ_WORDS = {
  openvoice: "오픈보이스", supertonic: "슈퍼토닉", whisper: "위스퍼", claude: "클로드", codex: "코덱스", aglink: "에이지링크",
  windows: "윈도우", wav: "웨이브", ok: "오케이", okay: "오케이", go: "고", git: "깃", commit: "커밋",
  push: "푸시", build: "빌드", server: "서버", test: "테스트", log: "로그", app: "앱", mode: "모드",
};
const READ_LETTERS = {
  a: "에이", b: "비", c: "씨", d: "디", e: "이", f: "에프", g: "지", h: "에이치", i: "아이", j: "제이",
  k: "케이", l: "엘", m: "엠", n: "엔", o: "오", p: "피", q: "큐", r: "알", s: "에스", t: "티",
  u: "유", v: "브이", w: "더블유", x: "엑스", y: "와이", z: "지",
};
const SINO_DIGITS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const SINO_DIGITS_ALONE = ["영", ...SINO_DIGITS.slice(1)];
// After a letter ("M2", "F2") a digit is read as an English number.
const ENGLISH_DIGITS = ["제로", "원", "투", "쓰리", "포", "파이브", "식스", "세븐", "에잇", "나인"];

function sinoNumber(digits) {
  const n = Number(digits);
  if (!Number.isFinite(n) || digits.length > 4 || n === 0) return [...digits].map((d) => SINO_DIGITS_ALONE[d]).join("");
  let out = "";
  [..."천백십"].forEach((unit, i) => {
    const d = Math.floor(n / 10 ** (3 - i)) % 10;
    if (d) out += (d === 1 ? "" : SINO_DIGITS[d]) + unit;
  });
  return out + SINO_DIGITS[n % 10];
}

function readAloud(text) {
  const decimals = String(text || "").replace(/(\d+)\.(\d+)/g, (_, a, b) => `${sinoNumber(a)}점${[...b].map((d) => SINO_DIGITS_ALONE[d]).join("")}`);
  return decimals.replace(/[A-Za-z]+(\d*)|\d+/g, (tok, tail = "") => {
    if (/^\d/.test(tok)) return sinoNumber(tok);
    const word = tok.slice(0, tok.length - tail.length);
    const known = READ_WORDS[word.toLowerCase()];
    // Unknown short or all-caps words (GPU, TTS) are spelled out letter by letter.
    const spoken = known ?? (word.length <= 4 || word === word.toUpperCase() ? [...word.toLowerCase()].map((c) => READ_LETTERS[c]).join("") : word);
    return spoken + [...tail].map((d) => ENGLISH_DIGITS[d]).join("");
  });
}

function echoReference(reply) {
  const r = normalizeForEcho(reply);
  return /[a-z0-9]/.test(r) ? r + normalizeForEcho(readAloud(reply)) + normalizeForEcho(speakNumbers(reply)) : r;
}

// isEcho: most of the segment's character pairs also occur in the reply being
// read. Whisper mishears our own voice a little, so this is fuzzy on purpose.
function isEcho(text, reply, overlap = ECHO_OVERLAP) {
  const t = normalizeForEcho(text);
  const r = echoReference(reply);
  if (t.length < 2) return true; // too short to tell — not worth stopping the reply for
  if (!r) return false;
  const pairs = new Set();
  for (let i = 0; i + 1 < r.length; i++) pairs.add(r.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i + 1 < t.length; i++) if (pairs.has(t.slice(i, i + 2))) hit++;
  const pairShare = hit / (t.length - 1);
  if (pairShare >= overlap) return true;
  // A misheard echo ("여섯 군데를 고쳤어요" → "6군대를 붙였어요") breaks many
  // pairs but keeps most single syllables; the user's own words rarely do both.
  const chars = new Set(r);
  let charHit = 0;
  for (const c of t) if (chars.has(c)) charHit++;
  return pairShare >= overlap * 0.65 && charHit / t.length >= 0.7;
}

const CMD_TAIL = String.raw`\s*(줘|주세요|줄래|봐|봐\s*줘|요)?[.!?~\s]*$`;
const cmdRE = (body) => new RegExp(String.raw`^\s*(${body})${CMD_TAIL}`, "i");
const SLOWER_RE = cmdRE(String.raw`(조금|좀|더|조금\s*더|좀\s*더)?\s*(천천히|느리게)\s*(말해|읽어|얘기해)`);
const FASTER_RE = cmdRE(String.raw`(조금|좀|더|조금\s*더|좀\s*더)?\s*(빨리|빠르게)\s*(말해|읽어|얘기해)`);
const SPEED_RESET_RE = cmdRE(String.raw`(말\s*|읽는\s*)?(빠르기|속도)\s*(를|을)?\s*(원래대로|기본으로|처음대로)\s*(해|돌려|바꿔)?`);
const REPEAT_RE = cmdRE(String.raw`(다시|한\s*번\s*더|방금\s*(거|답변)\s*다시)\s*(읽어|말해|들려)`);
const NEW_CONV_RE = cmdRE(String.raw`새\s*(로운\s*)?대화\s*(를)?\s*(시작|시작해|시작하자|열어|만들어|하자)`);
// "남자 목소리로 바꿔 줘", "목소리 여자 삼 번으로 해 줘", "음성을 여자로 바꿔":
// a short phrase before the verb (group 2 or 5), checked by isVoiceChoice.
const VOICE_CHANGE_RE = cmdRE(String.raw`(.{1,20}?)\s*(으로|로)?\s*(바꿔|바꾸자|바꿀래|변경해|변경)|(.{1,20}?)\s*(으로|로)\s*(해)`);
// Everything a voice choice is said with; anything else left over ("음성 인식
// 모델을 small에서 medium") means the sentence is about something else.
const VOICE_CHOICE_WORDS_RE = /(?<![a-z])[mf][1-5]?(?![a-z])|목소리|보이스|음성|남자|여자|남성|여성|에프|엠|다른|파이브|쓰리|하나|다섯|중에|걸|거|것|번|째|중|으로|로|을|를|은|는|좀|[1-5]|[일이삼사오원투포둘셋넷한두세네첫]|\s/gi;

function isVoiceChoice(phrase) {
  const p = String(phrase || "").trim();
  // "음성" alone is said of speech recognition too, so it needs a gender with it.
  if (!/목소리|보이스/.test(p) && !/^음성\s*(을|를|은)?\s*(남자|여자|남성|여성)/.test(p)) return false;
  return !p.replace(VOICE_CHOICE_WORDS_RE, "");
}
const DETAIL_RE = cmdRE(String.raw`(방금\s*(거|답변)\s*(을|를)?\s*)?(좀\s*)?(더\s*)?(자세히|전부|전체|끝까지|나머지|다)\s*(다\s*)?(읽어|말해|들려|얘기해)`);
// "글로만 보여 줘": replies are shown, not read, until "다시 말로 해 줘".
// The same words at the end of a request ("오늘 일정 정리해서 글로만 보여
// 줘") hold for that one reply only (ONCE_TEXT_RE).
const NO_SPEECH = String.raw`((말|소리|음성)\s*(로\s*)?(는\s*)?(하지\s*말고|없이|끄고|빼고)|읽지\s*(말고|마))`;
const TEXT_ONLY_ON_RE = cmdRE(String.raw`(이제\s*(부터)?\s*)?(답변\s*(은|을|도)?\s*)?(${NO_SPEECH}\s*)?(글|글자|글씨|텍스트|문자|화면)\s*(으로|로|에)?\s*만\s*(보여|띄워|해|알려|써)|(답변\s*(은|을|도)?\s*)?${NO_SPEECH}\s*(보여|띄워)`);
const TEXT_ONLY_OFF_RE = cmdRE(String.raw`(이제\s*)?(다시\s*)?(답변\s*(은|을|도)?\s*)?(말|소리|음성)\s*(로|으로)\s*(도\s*)?(다시\s*)?(읽어|말해|해|들려|알려|대답해)`);
const ONCE_TEXT_RE = new RegExp(String.raw`(${NO_SPEECH}\s*((글|글자|텍스트|화면)\s*(으로|로|에)?\s*)?(만\s*)?|(글|글자|텍스트|화면)\s*(으로|로|에)\s*만\s*)(보여|띄워|정리해|알려|써)\S*(\s*(줘|주세요|줄래))?[.!?~\s]*$`);
const SHORT_RE = cmdRE(String.raw`(방금\s*(거|답변)\s*(을|를)?\s*)?(좀\s*)?(요약|짧게|간단히|간단하게)\s*(해서\s*)?(다시\s*)?(읽어|말해|들려|얘기해)`);
// "목소리 등록해 줘" records the user's voice; "목소리 등록 해제해 줘" / "목소리
// 지워 줘" forgets it. Whole sentences only: "영상에서 목소리 지우는 법" is a question.
// Pause / resume listening without switching the mic off: while paused nothing
// said is sent or acted on except RESUME_RE and MIC_OFF_RE. MIC_OFF_RE switches
// voice off altogether; the user turns it on again by hand.
const PAUSE_RE = /^(음성\s*)?(인식|듣기|받아\s*쓰기|받아쓰기)\s*(을|를|은|는)?\s*(좀\s*)?(멈춰|멈춰\s*줘|멈춰\s*주세요|멈춰라|멈추자|멈출게|중지|중지해|중지해\s*줘|중단|중단해|그만|그만해|정지|정지해|꺼|꺼\s*줘|끄기)[.!?~\s]*$/;
const RESUME_RE = /^(다시\s*)(인식|들어|듣기|받아\s*써|받아\s*쓰기|받아쓰기)\s*(을|를)?\s*(해|해\s*줘|해\s*주세요|하자|시작|시작해|시작해\s*줘|줘|봐)?[.!?~\s]*$|^(인식|듣기)\s*(을|를)?\s*(다시\s*)?(시작|시작해|시작해\s*줘|재개|재개해|재개해\s*줘|켜|켜\s*줘)[.!?~\s]*$/;
const MIC_OFF_RE = /^(마이크|음성)\s*(을|를|좀)?\s*(꺼|꺼\s*줘|꺼\s*주세요|꺼라|끄자|끌게|끄기|꺼\s*버려)[.!?~\s]*$/;

const ENROLL_RE = cmdRE(String.raw`(제\s*|내\s*)?목소리\s*(로|를|좀)?\s*(좀\s*)?(등록|저장|기억)\s*(해|하자|해\s*둬|해\s*놔|할래)?`);
const UNENROLL_RE = cmdRE(String.raw`(제\s*|내\s*|등록한\s*|등록된\s*)?목소리\s*(등록\s*)?(을|를|은)?\s*(좀\s*)?(해제|취소|지워|삭제|지우기|없애)\s*(해|하자)?`);
// "방금 답 복사해 줘": the last answer (as written, markdown) goes on the clipboard.
// Only the answer itself or nothing may be named: "이 코드 복사해 줘" is a request.
const COPY_RE = cmdRE(String.raw`((방금|마지막|지금)\s*)?((거|것|답|답변|대답|그거)\s*(을|를|좀)?\s*)?(클립보드\s*(에|로)\s*)?(복사|카피)\s*(해|하자|해\s*둬|해\s*놔)?`);
// "다시 보내 줘": the last request said is sent again (it may not have gone through).
const RESEND_RE = cmdRE(String.raw`((방금|마지막)\s*(거|것|말|질문|요청)\s*(을|를|좀)?\s*)?(다시|한\s*번\s*더)\s*(보내|전송해|물어\s*봐)`);
// "말 명령 알려 줘": the list of these commands shows on screen.
const HELP_RE = cmdRE(String.raw`((말|음성)\s*)?(명령|명령어)\s*(을|를|은|이)?\s*(뭐\s*있어|목록\s*(보여|알려)?|도움말|보여|알려)|무슨\s*말\s*(을\s*)?(할\s*수\s*있어|하면\s*돼)`);
// "이거 읽어 줘": the editor's selection (or what is on screen) read aloud.
const READ_EDITOR_RE = cmdRE(String.raw`(이거|이것|여기|이\s*부분|선택한\s*(거|것|부분|글|코드)?|고른\s*(거|것|부분)|화면|화면에\s*(있는|보이는)\s*(거|것|글))\s*(을|를|좀)?\s*(좀\s*)?(소리\s*내서\s*)?(읽어|들려)`);
// "아까 답 다시 읽어 줘": the answer before the last one.
const PREV_READ_RE = cmdRE(String.raw`(아까|그\s*전|그\s*전에|이전|전)\s*(에\s*)?(거|것|답|답변|대답)\s*(을|를|좀)?\s*(다시\s*)?(읽어|말해|들려)`);
// "받아 적어 줘": what is said goes into the editor at the cursor until
// "받아 적기 끝" (DICTATE_END_RE). "받아쓰기 멈춰" is still PAUSE_RE.
const DICTATE_RE = cmdRE(String.raw`((에디터|편집기|파일|여기|커서)\s*(에|에다)?\s*)?(받아\s*적어|받아\s*적기\s*(시작|시작해|해)|받아쓰기\s*(시작|시작해|모드)|받아쓰기\s*해|그대로\s*(적어|써))`);
const DICTATE_END_RE = /^\s*(받아\s*적기\s*(끝|그만|종료|멈춰)\S*|받아쓰기\s*(끝|종료)\S*|그만\s*적어|다\s*적었어|적기\s*(끝|그만))\s*(줘|주세요|요)?[.!?~\s]*$/;
// Editor actions said in a word, a small fixed set (VOICE_ACTIONS): only the
// whole sentence counts, so "저장하는 법 알려 줘" still goes to the AI.
const SAVE_ALL_RE = cmdRE(String.raw`(파일\s*)?(모두|전부|다)\s*(저장|세이브)\s*(해|하자)?`);
const SAVE_RE = cmdRE(String.raw`(이\s*|지금\s*)?(파일\s*)?(을|를)?\s*(저장|세이브)\s*(해|하자)?`);
const TERMINAL_RE = cmdRE(String.raw`터미널\s*(을|를|좀)?\s*(열어|띄워|보여|켜)`);
// "앱 점 js 파일 열어 줘", "README 파일 열어": a file of the workspace by its name.
const OPEN_FILE_RE = /^\s*(.{1,30}?)\s*파일\s*(을|를|좀)?\s*(좀\s*)?(열어|띄워|보여)\s*(줘|주세요|줄래|봐)?[.!?~\s]*$/;
const NOT_A_FILE_NAME_RE = /^(이|그|저|지금|방금|아까|새|다른|열린|그\s*다음|이\s*번|설정)$/;
// Volume: "좀 더 크게 읽어 줘", "소리 작게 해 줘", "볼륨 올려 줘".
const MORE = String.raw`((조금|좀|더|조금\s*더|좀\s*더)\s*)?`;
const SOUND = String.raw`(소리|목소리|볼륨|음량)\s*(를|을|좀)?\s*`;
const LOUDER_RE = cmdRE(String.raw`${MORE}크게\s*(읽어|말해|얘기해)|${MORE}${SOUND}${MORE}(크게\s*(해|읽어|말해)|키워|올려)`);
const QUIETER_RE = cmdRE(String.raw`${MORE}작게\s*(읽어|말해|얘기해)|${MORE}${SOUND}${MORE}(작게\s*(해|읽어|말해)|줄여|낮춰|내려)`);
const VOLUME_STEP = 0.2;
const MAX_COMMAND_CHARS = 40; // longer sentences are always meant for the AI
const SPEED_STEP = 0.1; // "더 천천히" / "더 빨리"

// Spoken voice names: "남자 목소리로", "여자 삼 번", "에프 투로", "F2로".
const VOICE_GENDERS = [
  [/남자|남성|엠|(?<![a-z])m(?![a-z])/i, "M"], // a lone M, not the one in "medium"
  [/여자|여성|에프|(?<![a-z])f(?![a-z])/i, "F"],
];
const VOICE_NUMBERS = [
  ["1", "일", "원", "하나", "한", "첫"],
  ["2", "이", "투", "둘", "두"],
  ["3", "삼", "쓰리", "셋", "세"],
  ["4", "사", "포", "넷", "네"],
  ["5", "오", "파이브", "다섯"],
];
const VOICE_NUMBER_RE = new RegExp(`^(${VOICE_NUMBERS.flat().sort((a, b) => b.length - a.length).join("|")})`);

function voiceNumber(s) {
  const m = VOICE_NUMBER_RE.exec(s);
  return m ? VOICE_NUMBERS.findIndex((names) => names.includes(m[1])) + 1 : 0;
}

function voiceLabel(name) {
  return `${name[0] === "M" ? "남자" : "여자"} ${name[1]}번`;
}

// parseVoiceName finds the voice asked for, or "" when none is named. A bare
// "남자 목소리" means M2, the one the user chose; "다른 목소리" the next one.
function parseVoiceName(text, current) {
  const cur = TTS_VOICES.includes(current) ? current : "M2";
  let gender = "";
  let at = -1;
  for (const [re, g] of VOICE_GENDERS) {
    const m = re.exec(text);
    if (m && (at < 0 || m.index < at)) [gender, at] = [g, m.index + m[0].length];
  }
  const rest = gender ? text.slice(at).replace(/^\s*(목소리|음성|보이스)?\s*(중에?\s*)?/, "") : "";
  let n = gender ? voiceNumber(rest) : 0;
  if (!gender) {
    // "삼 번 목소리로" keeps the current one's gender
    const m = /(\S+)\s*번\s*(째\s*)?(목소리|음성)/.exec(text);
    n = m ? voiceNumber(m[1]) : 0;
    if (n) gender = cur[0];
  }
  if (/다른/.test(text) && !n) {
    gender ||= cur[0];
    n = gender === cur[0] ? (Number(cur[1]) % 5) + 1 : 2;
  }
  if (!gender) return "";
  return `${gender}${n || 2}`;
}

// A speaker turn in whisper's output: "- 그쵸." or, as it also writes them,
// "-그쵸." — but not a hyphen inside a word ("e-mail") or a minus ("-5도").
const DIALOGUE_RE = /(?:^|\s)-(?=\s|[^\s\d-])/g;

// cleanProse flattens one markdown paragraph to plain spoken text. Anything
// there to be looked at rather than heard — links, URLs, paths, inline code
// with dots or slashes — is dropped.
function cleanProse(p) {
  let s = p;
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+\[[^\]]*\]\([^)]*\)\s*$/gm, " "); // link-only list items
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/`[^`]*[\/:.][^`]*`/g, " "); // `paths`, `file.go:12`, `a.b()`
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/(?:[A-Za-z]:)?(?:[\w.~-]*[\/])+[\w.-]+/g, " "); // bare paths
  s = s.replace(/^\s{0,3}(>|[-*+]|\d+[.)])\s+/gm, "");
  s = s.replace(/(\*\*|__|~~|\*|_)(\S[^*_~]*?)\1/g, "$2");
  s = s.replace(/(\d)\s*~\s*(\d)/g, "$1에서 $2"); // "4~6초" is read "4에서 6초"
  s = s.replace(/[#*_~>|]+/g, " ");
  s = s.replace(/\p{Extended_Pictographic}️?/gu, " ");
  s = s.replace(/\s+([.,!?])/g, "$1");
  s = s.replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : "";
}

// speechText picks what is worth hearing from a reply, as a spoken summary of
// all of it: the opening prose paragraph (plus the next one when the first is a
// bare "네."), then the first sentence of every later paragraph and of each
// top-level list item — the point it makes — in the reply's order, and a
// closing question to the user. Code, tables, headings and a trailing "출처:"
// list never count.
const ITEM_LABEL_RE = /^[^.!?:：\d]{1,20}[:：]\s*/; // no digits: "10:30" is not a label

function speakableParas(md) {
  let s = String(md || "").replace(/\r\n/g, "\n");
  s = s.replace(/^\s*(출처|참고|Sources?|References?)\s*:?\s*$[\s\S]*/im, ""); // trailing sources block
  s = s.replace(/```[\s\S]*?```/g, "\n\n");
  s = s.replace(/^\s*\|.*\|\s*$/gm, ""); // tables
  s = s.replace(/^\s{0,3}#{1,6}\s.*$/gm, "\n"); // headings
  return s.split(/\n\s*\n/);
}
function speechText(md, mode = "gist") {
  const paras = speakableParas(md);
  if (mode === "full") return fullSpeechText(paras);
  const { chars: MAX_SPEAK_CHARS, sentences: MAX_SPEAK_SENTENCES, points: MAX_SPEAK_POINTS } = SPEAK_LIMITS[mode] || SPEAK_LIMITS.gist;
  let opening = "";
  let i = 0;
  for (; i < paras.length && opening.length < MIN_GIST_CHARS && sentencesOf(opening).length < 2; i++) {
    if (LIST_ITEM_RE.test(paras[i])) break; // a reply that opens with a list
    const prose = cleanProse(paras[i]);
    if (prose) opening = opening ? `${opening} ${prose}` : prose;
  }
  let out = "";
  for (const x of takeSentences(sentencesOf(opening), MAX_SPEAK_SENTENCES)) {
    if (out && (out + x).length > MAX_SPEAK_CHARS) break;
    out += x;
  }
  const points = [];
  let closing = "";
  for (const para of paras.slice(i)) {
    const items = para.split(/\n(?=[ ]{0,1}(?:[-*+]|\d+[.)])\s)/).filter((l) => LIST_ITEM_RE.test(l));
    if (items.length) {
      for (const item of items) {
        // A "**고친 것:**" lead-in read on its own sounds curt, like a report
        // being handed over; the sentence after it carries the point.
        const point = sentencesOf(cleanProse(item.split("\n")[0]).replace(ITEM_LABEL_RE, ""))[0];
        if (point) points.push(point);
      }
      closing = "";
      continue;
    }
    const prose = cleanProse(para);
    if (!prose) continue;
    const point = takeSentences(sentencesOf(prose), 1).join("");
    if (point) points.push(point);
    closing = prose;
  }
  // A point too long for what is left is passed over, so the shorter ones
  // after it still give the rest of the reply.
  for (const point of points.slice(0, MAX_SPEAK_POINTS)) {
    if ((out + point).length > MAX_SPEAK_CHARS) continue;
    out += ` ${point}`;
  }
  // A question at the end ("진행할까요?") is what the user has to answer.
  const ask = sentencesOf(closing).filter((x) => /[?？]\s*$/.test(x)).pop();
  if (ask && !out.includes(ask.trim())) out += ` ${ask}`;
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_SPEAK_CHARS + 120) out = out.slice(0, MAX_SPEAK_CHARS + 120);
  return out;
}

// A sentence that only announces what follows ("알아 두실 점이 두 가지
// 있어요.", "…이래요:") says nothing on its own: read alone it leaves the
// listener waiting. takeSentences takes the first n sentences and, when the
// last of them is one of these, the ones it announces — those that open with
// "하나는", "두 번째는", "마지막으로"… if there are any, else the next ones.
const COUNTS = { 두: 2, 세: 3, 네: 4, 다섯: 5 };
const COUNTED_RE = /(두|세|네|다섯)\s*(가지|개|곳|군데|단계)/;
const ANNOUNCE_RE = /((두|세|네|다섯|몇|여러)\s*(가지|개|곳|군데|단계)|다음과 같|이래요\s*[.:：]?\s*$|[:：]\s*$)/;
const ENUM_RE = /^\s*(하나는|다른 하나는|나머지 하나는|첫\s*(번)?\s*째|두\s*번\s*째|세\s*번\s*째|네\s*번\s*째|다섯\s*번\s*째|둘째|셋째|넷째|마지막)/;

function takeSentences(ss, n) {
  const out = ss.slice(0, n);
  const last = out[out.length - 1];
  if (!last || !ANNOUNCE_RE.test(last)) return out;
  const m = COUNTED_RE.exec(last);
  const k = m ? COUNTS[m[1]] : 2;
  const rest = ss.slice(out.length);
  const marked = rest.filter((x) => ENUM_RE.test(x));
  return out.concat((marked.length ? marked : rest).slice(0, k));
}

// fullSpeechText is the whole reply as speech for "자세히 읽어 줘": every prose
// paragraph and every list item in full, still without code, tables or links.
function fullSpeechText(paras) {
  const parts = [];
  for (const para of paras) {
    const items = para.split(/\n(?=[ ]{0,3}(?:[-*+]|\d+[.)])\s)/);
    for (const item of items) {
      const prose = cleanProse(item.replace(/\n+/g, " ")).replace(ITEM_LABEL_RE, "");
      if (prose) parts.push(/[.!?。？！]$/.test(prose) ? prose : `${prose}.`);
    }
  }
  let out = parts.join(" ").replace(/\s+/g, " ").trim();
  if (out.length > MAX_FULL_CHARS) out = sentencesOf(out.slice(0, MAX_FULL_CHARS)).slice(0, -1).join("").trim();
  return out;
}

// A period between digits ("1.5배") does not end a sentence.
function sentencesOf(text) {
  return (text || "").match(/(?:[^.!?。？！]|\.(?=\d))+[.!?。？！]*\s*/g) || [];
}

// splitSentences keeps each utterance short: speechSynthesis stalls on long
// ones, and with Supertonic the first sentence starts playing sooner.
function splitSentences(text) {
  const parts = text.match(/(?:[^.!?。？！\n]|\.(?=\d))+[.!?。？！]*\s*/g) || [text];
  const out = [];
  let cur = "";
  for (const p of parts) {
    // The first utterance is kept to one sentence: nothing plays until it is
    // synthesized, while the later ones are made during playback.
    if (cur && (!out.length || (cur + p).length > 120)) {
      out.push(cur.trim());
      cur = "";
    }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Whisper writes the name many ways ("아그링크~", "어글링크", "아글링", "아글랭크");
// the last syllable is often swallowed.
const WAKE_RE = /([아애에어악앙][글그클굴걸끌구]\s*[링린닝잉랭랑]\s*[크그큰구]?|알\s*링\s*크|에이\s*지\s*링크|a\s*g\s*(link|링크))/i;
const WAKE_TAIL_RE = /^[\s,.!?~]*(야|아|씨|님|가|는|도)?[\s,.!?~]*/; // "아글링크야, …"

const WAKE_MAX_LEAD = 1; // letters allowed before the name ("어, 아그라")

// Hangul split into its letters (초성/중성/종성), so "아구라" is one letter
// off "아그라" rather than a whole syllable.
function jamo(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c >= 0 && c < 11172) {
      out.push(`L${Math.floor(c / 588)}`, `V${Math.floor((c % 588) / 28)}`);
      if (c % 28) out.push(`T${c % 28}`);
    } else out.push(ch.toLowerCase());
  }
  return out;
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// matchWakeName finds a user-set name opening text, written a little
// differently or not; it returns where the name ends in text, or -1. Short
// names must come out exactly: one letter off "아그라" is already "아그래".
function matchWakeName(text, name, maxLead = WAKE_MAX_LEAD) {
  const letters = []; // [char, index in text] with spaces and marks left out
  for (let i = 0; i < text.length; i++) if (/[\p{L}\p{N}]/u.test(text[i])) letters.push([text[i], i]);
  const want = jamo(name);
  const allowed = Math.floor((want.length - 1) / 6);
  let best = null;
  for (let from = 0; from <= maxLead && from < letters.length; from++) {
    for (const len of [name.length, name.length - 1, name.length + 1]) {
      if (len < 1 || from + len > letters.length) continue;
      const d = editDistance(jamo(letters.slice(from, from + len).map(([c]) => c).join("")), want);
      if (d <= allowed && (!best || d < best.d)) best = { d, end: letters[from + len - 1][1] + 1 };
    }
    if (best) break; // the earliest place it starts
  }
  return best ? best.end : -1;
}

// wakeMatch: where the wake name ends in what was heard, or -1. The name has
// to open the sentence (give or take a "어," before it), so a passing mention
// in someone's talk does not count.
function wakeMatch(text, { wakeDefault = true, wakeNames = [] } = {}) {
  if (wakeDefault) {
    const m = WAKE_RE.exec(text);
    if (m && m.index <= 4) return m.index + m[0].length;
  }
  for (const name of wakeNames) {
    const end = matchWakeName(text, name);
    if (end >= 0) return end;
  }
  return -1;
}

// What may follow a user's own end word: "끝이야", "됐어요", "스톱해 줘".
const STOP_TAIL_RE = /^[\s,.!?~]*(이야|야|이요|요|해|해요|하자|할게|할래|해\s*줘|해\s*주세요)?[\s,.!?~]*$/;

// stopMatch: the whole sentence is a word that ends the conversation — "그만"
// and its kind, or one of the user's own (written a little differently or
// not, but nothing before it: "안 끝" is not "끝").
function stopMatch(text, { stopDefault = true, stopWords = [] } = {}) {
  const t = String(text || "").trim();
  if ((stopDefault || !stopWords.length) && CONV_STOP_RE.test(t)) return true;
  if (!t || t.length > MAX_COMMAND_CHARS) return false;
  for (const word of stopWords) {
    const end = matchWakeName(t, word, 0);
    if (end >= 0 && STOP_TAIL_RE.test(t.slice(end))) return true;
  }
  return false;
}

// wakeNameLabel is how the wake name is said in replies: the user's own first.
function wakeNameLabel({ wakeNames = [] } = {}) {
  return wakeNames[0] || "아글링크";
}

// wakePrompt is the wake names as a Whisper initial prompt: hearing a short
// lone name ("아글링크", "길동아") the CPU model often mis-transcribes it, so
// priming it with the names it should expect sharply raises the hit rate. Used
// only on the wake clip, never on dictation, so it does not skew normal text.
function wakePrompt({ wakeDefault = true, wakeNames = [] } = {}) {
  const names = [...(wakeDefault ? ["아글링크"] : []), ...wakeNames];
  return names.join(", ");
}

// parseCommand tells which voice command text is, or null when it is meant for
// Claude Code. Each command has to be the whole sentence (give or take a "줘"),
// so a question that merely mentions one is still sent. current is the voice
// now in use, for "다른 목소리로".
function parseCommand(text, current = "M2") {
  const t = String(text || "").trim();
  if (!t || t.length > MAX_COMMAND_CHARS) return null;
  const named = WAKE_NAME_SET_RE.exec(t) || WAKE_NAME_ADD_RE.exec(t);
  if (named) {
    const set = WAKE_NAME_SET_RE.test(t);
    return { kind: "wakeName", set, name: cleanWakeNames([set ? named[2] : named[1]])[0] || "" };
  }
  if (DICTATE_END_RE.test(t)) return { kind: "dictate", on: false };
  if (DICTATE_RE.test(t)) return { kind: "dictate", on: true };
  // Before the reading's "멈춰" (hush): "인식 멈춰" pauses listening instead.
  if (PAUSE_RE.test(t)) return { kind: "pause" };
  if (RESUME_RE.test(t)) return { kind: "resume" };
  if (MIC_OFF_RE.test(t)) return { kind: "micOff" };
  if (LISTEN_ALWAYS_RE.test(t)) return { kind: "listen", mode: "always" };
  if (LISTEN_WAKE_RE.test(t)) return { kind: "listen", mode: "wake" };
  if (TEXT_ONLY_ON_RE.test(t)) return { kind: "textOnly", on: true };
  if (TEXT_ONLY_OFF_RE.test(t)) return { kind: "textOnly", on: false };
  if (DETAIL_RE.test(t)) return { kind: "read", mode: "full" };
  if (SHORT_RE.test(t)) return { kind: "read", mode: "short" };
  if (UNENROLL_RE.test(t)) return { kind: "unenroll" };
  if (ENROLL_RE.test(t)) return { kind: "enroll" };
  if (BARGE_ON_RE.test(t)) return { kind: "barge", on: true };
  if (BARGE_OFF_RE.test(t)) return { kind: "barge", on: false };
  if (BARGE_HUSH_RE.test(t)) return { kind: "hush" };
  if (PREV_READ_RE.test(t)) return { kind: "read", mode: "", which: "previous" };
  if (REPEAT_RE.test(t)) return { kind: "read", mode: "" };
  if (READ_EDITOR_RE.test(t)) return { kind: "readEditor" };
  if (LOUDER_RE.test(t)) return { kind: "volume", delta: VOLUME_STEP };
  if (QUIETER_RE.test(t)) return { kind: "volume", delta: -VOLUME_STEP };
  if (SAVE_ALL_RE.test(t)) return { kind: "action", action: "saveAll" };
  if (SAVE_RE.test(t)) return { kind: "action", action: "save" };
  if (TERMINAL_RE.test(t)) return { kind: "action", action: "terminal" };
  if (SLOWER_RE.test(t)) return { kind: "speed", delta: -SPEED_STEP };
  if (FASTER_RE.test(t)) return { kind: "speed", delta: SPEED_STEP };
  if (SPEED_RESET_RE.test(t)) return { kind: "speed", delta: null };
  if (NEW_CONV_RE.test(t)) return { kind: "newConversation" };
  if (COPY_RE.test(t)) return { kind: "copy" };
  if (RESEND_RE.test(t)) return { kind: "resend" };
  if (HELP_RE.test(t)) return { kind: "help" };
  const vc = VOICE_CHANGE_RE.exec(t);
  if (vc && isVoiceChoice(vc[2] ?? vc[5])) return { kind: "voice", name: parseVoiceName(t, current) };
  const f = OPEN_FILE_RE.exec(t);
  if (f) {
    const name = f[1].replace(/\s*(이라는|라는|이란|란)$/, "").trim();
    if (name && !NOT_A_FILE_NAME_RE.test(name)) return { kind: "openFile", name };
  }
  return null;
}

// spokenFileName turns a file name as said ("앱 점 js", "README 점 엠디") into
// the letters to look for: lower case, "점"/"닷" as ".", spaces left out.
function spokenFileName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s*(점|닷)\s*/g, ".")
    .replace(/[\s"“”'`]/g, "");
}

// fileNameScore says how well a file's base name fits what was said: 3 the
// whole name, 2 the name without its extension, 1 a part of it, 0 not at all.
// The base name is also tried as it is read aloud ("readme" → "리드미" is not
// known, but "test" → "테스트" is), for names said in Hangul.
function fileNameScore(said, base) {
  const want = spokenFileName(said);
  if (!want) return 0;
  const b = String(base || "").toLowerCase();
  const stem = b.replace(/\.[^.]+$/, "");
  const squash = (s) => s.replace(/[\s._-]/g, "");
  const spoken = squash(readAloud(stem));
  if (b === want) return 3;
  if (stem === want || squash(stem) === squash(want) || (spoken && spoken === squash(want))) return 2;
  if (want.length >= 2 && (b.includes(want) || squash(b).includes(squash(want)) || (spoken && spoken.includes(squash(want))))) return 1;
  return 0;
}

// splitContext finds a request that asks to look at the editor first: "이
// 파일 보고 이 함수 설명해 줘" (the active file and selection), "에러 보고 고쳐
// 줘" (the Problems list). It returns {context: "file" | "errors", text} with
// the words kept as said, or null.
// The verb must end there ("보고서" is a report): a space or a comma, then more.
const CONTEXT_TAIL = String.raw`\s*(을|를|좀)?\s*(보고|보면서|참고해서|참고해|읽고)(\s*[,，]\s*|\s+)\S`;
const CONTEXT_FILE_RE = new RegExp(String.raw`^\s*(이\s*파일|지금\s*파일|열린\s*파일|이\s*코드|선택한\s*(거|것|부분|코드)|고른\s*(거|것|부분))` + CONTEXT_TAIL);
const CONTEXT_ERRORS_RE = new RegExp(String.raw`^\s*(에러|오류|문제|빨간\s*줄|경고)\s*(들)?` + CONTEXT_TAIL);
function splitContext(text) {
  const t = String(text || "").trim();
  if (CONTEXT_FILE_RE.test(t)) return { context: "file", text: t };
  if (CONTEXT_ERRORS_RE.test(t)) return { context: "errors", text: t };
  return null;
}

// splitAddressee finds a question said to one agent by name: "코덱스한테 이거
// 고쳐 줘", "클로드야, …", "… 라고 코덱스한테 전해 줘". It returns {agent,
// text} with the name taken off, or null. A bare name is not enough —
// "코덱스 설정 열어 줘" talks about Codex — so it needs 한테/에게/께, a call
// (야/아) or a comma after the name.
const ADDRESSEES = [
  { agent: "codex", names: [String.raw`코덱스`, String.raw`코덱쓰`, String.raw`코댁스`, String.raw`codex`] },
  { agent: "claude", names: [String.raw`클로드\s*코드`, String.raw`클로드`, String.raw`클라우드\s*코드`, String.raw`claude\s*code`, String.raw`claude`] },
];
// after the name: 한테/에게/께 (maybe a comma), 야/아 then a comma or a space, or just a comma
const TO_RE = String.raw`(?:\s*(?:한테|에게|께)\s*[,，:]?|(?:야|아)\s*[,，]|(?:야|아)(?=\s)|\s*[,，:])`;
const ADDR_HEAD = ADDRESSEES.map((a) => ({ agent: a.agent, re: new RegExp(String.raw`^\s*(?:${a.names.join("|")})${TO_RE}\s*`, "i") }));
// "<question> (라고) 코덱스한테 전해/보내/말해/물어봐 (줘)" at the end
const ADDR_TAIL = ADDRESSEES.map((a) => ({
  agent: a.agent,
  re: new RegExp(
    String.raw`(?:\s+(?:이)?라고)?\s*[,，]?\s*(?:${a.names.join("|")})\s*(?:한테|에게|께)\s*(?:전해|보내|말해|물어\s*봐|물어|넣어|전달해|시켜)\s*(?:줘|주세요|줄래|봐|볼래)?\s*[.!?。]*\s*$`,
    "i"
  ),
}));
function splitAddressee(text) {
  const t = String(text || "");
  for (const { agent, re } of ADDR_HEAD) {
    const m = re.exec(t);
    if (m && t.slice(m[0].length).trim()) return { agent, text: t.slice(m[0].length).trim() };
  }
  for (const { agent, re } of ADDR_TAIL) {
    const m = re.exec(t);
    if (m && t.slice(0, m.index).trim()) return { agent, text: t.slice(0, m.index).trim() };
  }
  return null;
}

// VOICE_COMMANDS is the spoken commands as the help list shows them: what to
// say (every example is checked to be taken as that command — see the tests)
// and what it does. Kinds "stop", "wake", "to" and "context" are stopMatch's,
// wakeMatch's, splitAddressee's and splitContext's; the rest parseCommand's.
const VOICE_COMMANDS = [
  { kind: "wake", group: "대화", does: "대화 시작 (호출어 방식일 때)", says: ["아글링크", "아글링크, 테스트 돌려 줘"] },
  { kind: "stop", group: "대화", does: "대화 끝내기", says: ["그만", "대화 끝", "종료"] },
  { kind: "hush", group: "읽기", does: "읽기 멈추기", says: ["잠깐", "멈춰", "그만 읽어"] },
  { kind: "read", group: "읽기", does: "방금 답 · 그 전 답 다시 읽기, 자세히 · 짧게 읽기", says: ["다시 읽어 줘", "아까 답 다시 읽어 줘", "자세히 읽어 줘", "요약해서 읽어 줘"] },
  { kind: "readEditor", group: "편집기", does: "편집기에서 고른 글(없으면 화면에 보이는 글) 읽기", says: ["이거 읽어 줘", "선택한 부분 읽어 줘"] },
  { kind: "dictate", group: "편집기", does: "받아 적기: 말한 것을 커서 자리에 적기 / 마치기", says: ["받아 적어 줘", "받아 적기 끝"] },
  { kind: "openFile", group: "편집기", does: "작업 폴더에서 이름으로 파일 열기", says: ["README 파일 열어 줘", "extension 점 js 파일 열어 줘"] },
  { kind: "action", group: "편집기", does: "저장 · 모두 저장 · 터미널 열기", says: ["저장해 줘", "모두 저장해 줘", "터미널 열어 줘"] },
  { kind: "context", group: "편집기", does: "열린 파일(고른 부분)이나 문제 목록을 질문에 붙여 보내기", says: ["이 파일 보고 이 함수 설명해 줘", "에러 보고 고쳐 줘"] },
  { kind: "speed", group: "읽기", does: "읽는 빠르기", says: ["좀 더 천천히 말해 줘", "빨리 읽어 줘", "속도 원래대로 해 줘"] },
  { kind: "voice", group: "읽기", does: "읽는 목소리 (남자 1~5번, 여자 1~5번)", says: ["여자 삼 번 목소리로 바꿔 줘", "다른 목소리로 바꿔 줘"] },
  { kind: "textOnly", group: "읽기", does: "답을 읽지 않고 글로만 / 다시 읽기", says: ["글로만 보여 줘", "다시 말로 해 줘"] },
  { kind: "volume", group: "읽기", does: "읽는 소리 크기", says: ["좀 더 크게 읽어 줘", "소리 작게 해 줘", "볼륨 올려 줘"] },
  { kind: "copy", group: "답과 요청", does: "방금 답을 클립보드에 복사", says: ["복사해 줘", "방금 답 복사해 줘"] },
  { kind: "resend", group: "답과 요청", does: "방금 한 요청을 한 번 더 보내기", says: ["다시 보내 줘", "방금 질문 다시 보내 줘"] },
  { kind: "newConversation", group: "답과 요청", does: "새 대화 열기", says: ["새 대화 시작해 줘"] },
  { kind: "to", group: "답과 요청", does: "이번 질문만 정한 쪽으로 보내기", says: ["코덱스한테 이 함수 고쳐 줘", "클로드야, 테스트 돌려 줘"] },
  { kind: "pause", group: "듣기", does: "듣기 잠시 멈추기", says: ["인식 멈춰"] },
  { kind: "resume", group: "듣기", does: "멈춘 듣기 다시 하기", says: ["다시 인식해"] },
  { kind: "micOff", group: "듣기", does: "음성 끄기", says: ["마이크 꺼 줘"] },
  { kind: "listen", group: "듣기", does: "늘 듣기 / 부를 때만 듣기", says: ["항상 듣기로 해 줘", "호출어로 켜 줘"] },
  { kind: "barge", group: "듣기", does: "읽는 중에 말하면 멈추기 켜기 · 끄기", says: ["끼어들기 켜 줘", "끼어들기 꺼 줘"] },
  { kind: "wakeName", group: "설정", does: "부르는 이름 바꾸기 · 더하기", says: ["부르는 이름을 자비스로 바꿔 줘", "자비스라고 불러도 대답해 줘"] },
  { kind: "enroll", group: "설정", does: "내 목소리 등록", says: ["목소리 등록해 줘"] },
  { kind: "unenroll", group: "설정", does: "등록한 목소리 지우기", says: ["목소리 등록 해제해 줘"] },
  { kind: "help", group: "설정", does: "이 목록 보기", says: ["말 명령 알려 줘", "무슨 말 할 수 있어"] },
];

module.exports = {
  TTS_VOICES,
  VOICE_COMMANDS,
  VOLUME_STEP,
  spokenFileName,
  fileNameScore,
  splitContext,
  MAX_WAKE_NAMES,
  SENTENCE_END_RE,
  GOES_ON_RE,
  CONV_STOP_RE,
  BARGE_HUSH_RE,
  ECHO_OVERLAP,
  ECHO_TRUST_MARGIN,
  CUT_MARGIN,
  ONCE_TEXT_RE,
  DIALOGUE_RE,
  WAKE_TAIL_RE,
  clamp,
  cleanWakeNames,
  normalizeForEcho,
  readAloud,
  isEcho,
  voiceLabel,
  parseVoiceName,
  parseCommand,
  splitAddressee,
  speechText,
  sentencesOf,
  splitSentences,
  matchWakeName,
  wakeMatch,
  wakeNameLabel,
  wakePrompt,
  stopMatch,
};
