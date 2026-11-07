"use strict";

// Supertonic reads raw digits unevenly ("2번" as 이 번 or 두 번 at random,
// "18:39" digit by digit), so numbers are spelled out in Hangul the way people
// say them before synthesis: native numbers with counting words (두 번, 세 개,
// 한 시간), Sino-Korean otherwise (삼십구 분, 이천이십육 년).

const SINO = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
const DIGIT = ["영", ...SINO.slice(1)];
const NATIVE_ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const NATIVE_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];

// Counting words that take native numbers. "개월" and "달러" are not "개", "달".
const NATIVE_COUNTER_RE = /^\s?(시간|개(?!월)|명|사람|살|마리|가지|달(?!러)|잔|권|군데|곳|줄|차례|통|벌|켤레|그릇|병|송이|번째)/;
const PARTICLE_RE = /^(에서|에게|에|은|는|이|가|을|를|도|만|까지|부터|으로|로|와|과|의|쯤|이나|나|보다)(?![가-힣])/;
const HOUR_RE = /^\s?시(?![간작험도켜키])/;
// "N번" counts when it reads as how many times; otherwise it is a number (2번 목소리).
const BEON_COUNT_RE = /^\s?번(\s?(씩|이나|정도|만에|쯤|도|만|더|이상|넘게|연속|째)|\s+(시도|반복|했|해|하|눌|말|읽|불|확인|들|봤|물|돌|와|왔|갔|실패|성공|녹음|설치|호출|걸|바꿨|바꾸))/;

function sinoUnder10000(n) {
  let out = "";
  for (const [u, name] of [[1000, "천"], [100, "백"], [10, "십"]]) {
    const d = Math.floor(n / u) % 10;
    if (d) out += (d === 1 ? "" : SINO[d]) + name;
  }
  return out + SINO[n % 10];
}

function digitByDigit(s) {
  return [...s].map((d) => DIGIT[d]).join("");
}

function sinoNumber(digits) {
  const s = String(digits).replace(/,/g, "");
  if (/^0\d/.test(s) || s.length > 16) return digitByDigit(s);
  let n = BigInt(s);
  if (n === 0n) return "영";
  const units = ["", "만", "억", "조"];
  const parts = [];
  for (let i = 0; n > 0n; i++, n /= 10000n) {
    const part = Number(n % 10000n);
    if (part) parts.unshift((i === 1 && part === 1 ? "" : sinoUnder10000(part)) + units[i]);
  }
  return parts.join(" ");
}

function nativeNumber(n) {
  if (n === 20) return "스무";
  return NATIVE_TENS[Math.floor(n / 10)] + NATIVE_ONES[n % 10];
}

function hourSpoken(h) {
  if (h === 0 || h === 24) return "밤 열두";
  if (h < 12) return `오전 ${nativeNumber(h)}`;
  if (h === 12) return "낮 열두";
  return `오후 ${nativeNumber(h - 12)}`;
}

function integerSpoken(int, after) {
  const s = int.replace(/,/g, "");
  if (/^0\d/.test(s)) return digitByDigit(s);
  const n = Number(s);
  if (/^\s?월/.test(after) && n >= 1 && n <= 12) return n === 6 ? "유" : n === 10 ? "시" : sinoNumber(s);
  if (n >= 1 && n < 100) {
    if (/^\s?번째/.test(after)) return n === 1 ? "첫" : nativeNumber(n);
    if (NATIVE_COUNTER_RE.test(after)) return nativeNumber(n);
    if (HOUR_RE.test(after)) return n <= 12 ? nativeNumber(n) : n < 24 ? `오후 ${nativeNumber(n - 12)}` : sinoNumber(s);
    if (BEON_COUNT_RE.test(after)) return nativeNumber(n);
  }
  return sinoNumber(s);
}

function speakNumbers(text) {
  let s = String(text || "");
  s = s.replace(/(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/g, (_, y, mo, d) => `${y}년 ${Number(mo)}월 ${Number(d)}일`);
  s = s.replace(/(?<![\w:.])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])/g, (m, h, mi, se) => {
    const hour = Number(h);
    if (hour > 24 || Number(mi) > 59 || (se && Number(se) > 59)) return m;
    let out = `${hourSpoken(hour)} 시`;
    if (Number(mi)) out += ` ${sinoNumber(mi.replace(/^0/, ""))} 분`;
    if (se && Number(se)) out += ` ${sinoNumber(se.replace(/^0/, ""))} 초`;
    return out;
  });
  s = s.replace(/(?<![A-Za-z])[vV](?=\d+(?:\.\d+)+)/g, "버전 ");
  s = s.replace(/(?<![\w.])\d+(?:\.\d+){2,}(?![\w.]*\d)/g, (v) => v.split(".").map(sinoNumber).join(" 점 "));
  s = s.replace(/(\d)\s?%/g, "$1 퍼센트");
  return s.replace(/(?<![A-Za-z\d.])(\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.(\d+))?/g, (m, int, frac, offset, whole) => {
    const after = whole.slice(offset + m.length);
    // "이번 목소리" would be heard as "this time"; a counter is set apart: "이 번".
    const gap = /^[가-힣]/.test(after) && !/^월/.test(after) && !PARTICLE_RE.test(after) ? " " : "";
    if (frac !== undefined) return `${sinoNumber(int)} 점 ${digitByDigit(frac.replace(/(?<=.)0+$/, ""))}${gap}`;
    return integerSpoken(int, after) + gap;
  });
}

module.exports = { speakNumbers, sinoNumber };
