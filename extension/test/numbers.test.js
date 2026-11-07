"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { speakNumbers } = require("../core/numbers");

test("numbers are read the way people say them", () => {
  const cases = {
    "18:39에 시작": "오후 여섯 시 삼십구 분에 시작",
    "09:31": "오전 아홉 시 삼십일 분",
    "2번 목소리": "이 번 목소리",
    "2번 시도했어요": "두 번 시도했어요",
    "14건은": "십사 건은",
    "3개, 5명, 1시간 30분": "세 개, 다섯 명, 한 시간 삼십 분",
    "1번째와 2번째": "첫 번째와 두 번째",
    "6월 10일": "유월 십 일",
    "2026-11-07": "이천이십육 년 십일월 칠 일",
    "0.90, 0.4": "영 점 구, 영 점 사",
    "v1.2.14": "버전 일 점 이 점 십사",
    "40%": "사십 퍼센트",
    "1,234,567원": "백이십삼만 사천오백육십칠 원",
    "M2, F3": "M2, F3",
    "13시": "오후 한 시",
    "12개월, 20살": "십이 개월, 스무 살",
    "4에서 6초": "사에서 육 초",
  };
  for (const [input, want] of Object.entries(cases)) assert.strictEqual(speakNumbers(input), want, input);
});
