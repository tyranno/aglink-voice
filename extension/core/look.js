// How the status bar button shows what the voice is doing while speech is
// coming in. No VS Code here: standalone.js turns the look into the button.
"use strict";

const HEAR_FRAME_MS = 300;

// stateLook: sound coming in is a mic with 1-3 waves (media/aglink-icons.woff,
// frame cycles) on the red of a recording light, so it stands out from plain
// listening.
function stateLook(st, frame = 0) {
  if (st.hearing) return { icon: `$(aglink-hear-${(frame % 3) + 1})`, text: "듣는 중", bg: "statusBarItem.errorBackground" };
  switch (st.phase) {
    case "preparing": // recognition is still loading
      return { icon: "$(loading~spin)", text: "준비 중", bg: "statusBarItem.warningBackground" };
    case "listening":
      return { icon: "$(mic-filled)", text: "말씀하세요", bg: "statusBarItem.warningBackground" };
    case "transcribing":
      return { icon: "$(loading~spin)", text: "알아듣는 중", bg: "statusBarItem.warningBackground" };
    case "waiting":
      return { icon: "$(watch)", text: "답 기다리는 중", bg: "statusBarItem.warningBackground" };
    case "speaking":
    case "done":
      return { icon: "$(unmute)", text: "읽는 중", bg: "statusBarItem.warningBackground" };
    case "problem":
      return { icon: "$(warning)", text: "문제가 있어요", bg: "statusBarItem.errorBackground" };
    default:
      return { icon: "$(mic-filled)", text: "음성 켜짐", bg: "statusBarItem.warningBackground" };
  }
}

module.exports = { stateLook, HEAR_FRAME_MS };
