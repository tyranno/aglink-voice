// The settings screen: one VS Code tab with every aglinkVoice.* setting as a
// form — what each does in a sentence, a preview of the voice, enrolling the
// user's voice. It edits the same settings as VS Code's own settings page
// (user settings), and follows them when they change there or by voice.
"use strict";

const crypto = require("crypto");
const { TTS_VOICES, voiceLabel, cleanWakeNames, MAX_WAKE_NAMES } = require("./core/text");

const SECTION = "aglinkVoice";
const KEYS = ["voice", "speed", "listenMode", "wakeDefault", "wakeNames", "stopDefault", "stopWords", "wakeIdleMin", "summary", "textOnly", "readTyped", "barge", "speakerMin", "micDevice", "outputDevice", "source", "enginePath", "engineRoot"];

let panel = null;

// open shows the settings tab (one per VS Code window). host gives what the
// panel shows beside the settings and what its buttons do:
//   status() → {on, enrolled, desktop}; onChange(fn) → disposable;
//   toggle(), preview(), enroll(), unenroll(), pickMic(), pickOutput().
function openSettings(vscode, host) {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel("aglinkVoice.settings", "aglink 음성 설정", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
  const cfg = () => vscode.workspace.getConfiguration(SECTION);
  const post = () => {
    if (!panel) return;
    const values = {};
    for (const k of KEYS) values[k] = cfg().get(k);
    void panel.webview.postMessage({ type: "state", values, ...host.status() });
  };
  panel.webview.html = html(crypto.randomBytes(16).toString("base64"));
  const subs = [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) post();
    }),
    host.onChange(post),
    panel.webview.onDidReceiveMessage(async (m) => {
      try {
        switch (m.type) {
          case "ready":
            post();
            break;
          case "set": {
            if (!KEYS.includes(m.key)) break;
            let v = m.value;
            if (m.key === "wakeNames") v = cleanWakeNames(String(v).split(/[,，]/)).slice(0, MAX_WAKE_NAMES);
            if (m.key === "stopWords") v = cleanWakeNames(String(v).split(/[,，]/), 1).slice(0, MAX_WAKE_NAMES);
            if ((m.key === "enginePath" || m.key === "engineRoot") && !String(v).trim()) v = undefined; // back to where the setup put it
            await cfg().update(m.key, v, vscode.ConfigurationTarget.Global);
            post(); // a value cleaned up (wake names) goes back to the form
            break;
          }
          case "toggle":
            await host.toggle();
            break;
          case "preview":
            await host.preview();
            break;
          case "enroll":
            await host.enroll();
            break;
          case "unenroll":
            host.unenroll();
            break;
          case "pickMic":
            await host.pickMic();
            break;
          case "pickOutput":
            await host.pickOutput();
            break;
          case "native":
            await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:aglink.aglink-voice");
            break;
        }
      } catch (e) {
        vscode.window.showErrorMessage(`aglink 음성: ${e.message}`);
      }
    }),
  ];
  panel.onDidDispose(() => {
    for (const s of subs) s.dispose();
    panel = null;
  });
}

function html(nonce) {
  const voices = TTS_VOICES.map((v) => `<option value="${v}">${voiceLabel(v)}</option>`).join("");
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 24px 40px; max-width: 760px; line-height: 1.5; }
  h1 { font-size: 1.5em; font-weight: 600; margin: 12px 0 4px; }
  h2 { font-size: 1.1em; font-weight: 600; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-settings-headerBorder, var(--vscode-panel-border)); }
  .lead, .desc { color: var(--vscode-descriptionForeground); }
  .desc { margin: 2px 0 0; font-size: 0.95em; }
  .row { margin: 14px 0; }
  .row > label.title { font-weight: 600; display: block; margin-bottom: 4px; }
  .inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  select, input[type=text] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font: inherit; }
  input[type=text] { width: 100%; box-sizing: border-box; }
  input[type=range] { width: 260px; accent-color: var(--vscode-button-background); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 12px; font: inherit; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .check { display: flex; gap: 8px; align-items: flex-start; }
  .check input { margin-top: 4px; }
  .radio { display: flex; gap: 8px; align-items: flex-start; margin: 6px 0; }
  .radio input { margin-top: 4px; }
  .value { min-width: 3.5em; font-variant-numeric: tabular-nums; }
  .banner { padding: 8px 12px; margin: 12px 0; border-left: 3px solid var(--vscode-notificationsInfoIcon-foreground, var(--vscode-focusBorder)); background: var(--vscode-textBlockQuote-background); }
  .status { display: flex; align-items: center; gap: 12px; margin: 12px 0; }
  .pill { padding: 2px 10px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  details summary { cursor: pointer; font-weight: 600; margin: 28px 0 8px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  table { border-collapse: collapse; margin-top: 6px; }
  td { padding: 2px 16px 2px 0; vertical-align: top; }
  td:first-child { white-space: nowrap; }
</style>
</head>
<body>
<h1>aglink 음성 설정</h1>
<p class="lead">Claude Code 에 말로 묻고 답을 소리로 듣는 기능의 설정이에요. 바꾸면 바로 적용돼요.</p>

<div class="status">
  <span class="pill" id="onState">음성 꺼짐</span>
  <button id="toggle">음성 대화 켜기</button>
  <span class="desc">단축키 Ctrl+Alt+V, 또는 오른쪽 아래 "음성" 버튼</span>
</div>
<div class="banner" id="desktopBanner" hidden>지금은 aglink 데스크톱 앱의 음성을 쓰고 있어서, 목소리·빠르기 같은 설정은 데스크톱 앱 설정을 따라요. 아래 설정은 이 확장의 엔진을 쓸 때 적용돼요 (맨 아래 "고급"에서 바꿀 수 있어요).</div>

<h2>목소리</h2>
<div class="row">
  <label class="title" for="voice">읽어 주는 목소리</label>
  <div class="inline">
    <select id="voice">${voices}</select>
    <button class="secondary" id="preview">들어 보기</button>
  </div>
  <p class="desc">답을 읽어 줄 목소리예요. 남자 1~5번, 여자 1~5번 중에서 골라요. 대화 중에 "여자 3번 목소리로 바꿔 줘" 라고 말해도 돼요.</p>
</div>
<div class="row">
  <label class="title" for="speed">읽는 빠르기</label>
  <div class="inline">
    <input type="range" id="speed" min="0.7" max="2" step="0.05">
    <span class="value" id="speedValue"></span>
    <button class="secondary" id="speedReset">보통으로</button>
  </div>
  <p class="desc">1 이 보통 빠르기예요. 작을수록 천천히, 클수록 빨리 읽어요 (0.7~2배). "좀 더 천천히", "빨리 읽어 줘" 라고 말해도 돼요.</p>
</div>

<h2>듣는 방식</h2>
<div class="row">
  <label class="radio"><input type="radio" name="listenMode" value="wake"><span><b>호출어로 시작</b><br><span class="desc">음성을 켜 두면 "아글링크" 라고 부를 때 대화가 시작돼요. 한동안 말이 없거나 "그만" 하면 다시 부를 때까지 기다려요.</span></span></label>
  <label class="radio"><input type="radio" name="listenMode" value="always"><span><b>켜면 바로 대화</b><br><span class="desc">음성을 켜면 부르지 않아도 바로 들어요. 끝내는 말("그만")을 하면 호출어를 기다려요.</span></span></label>
  <label class="radio"><input type="radio" name="listenMode" value="manual"><span><b>켤 때만 듣기</b><br><span class="desc">음성을 켜면 바로 듣고, 끝내는 말("그만")을 하면 음성이 꺼져요. 호출어는 쓰지 않아요.</span></span></label>
</div>
<div class="row">
  <label class="check"><input type="checkbox" id="wakeDefault"><span><b>"아글링크" 로 불러도 깨어나기</b><br><span class="desc">끄면 아래에 정한 이름으로만 깨어나요.</span></span></label>
</div>
<div class="row">
  <label class="title" for="wakeNames">다른 부를 이름</label>
  <input type="text" id="wakeNames" placeholder="예: 자비스, 비서야">
  <p class="desc">"아글링크" 말고도 부를 이름이에요. 쉼표로 나눠서 5개까지, 한 이름은 2~10글자로 적어 주세요. 말은 한국어로 받아 적으니, 영어 이름은 들리는 대로 한글로도 함께 적어 주세요 (예: Jarvis, 자비스).</p>
</div>
<div class="row">
  <label class="check"><input type="checkbox" id="stopDefault"><span><b>"그만" 으로도 끝내기</b><br><span class="desc">"그만", "그만해", "대화 끝", "종료" 라고 하면 대화를 끝내요. 끄면 아래에 정한 말로만 끝나요.</span></span></label>
</div>
<div class="row">
  <label class="title" for="stopWords">다른 끝내는 말</label>
  <input type="text" id="stopWords" placeholder="예: 됐어, 수고했어, 끝">
  <p class="desc">대화를 끝낼 내 말이에요. 쉼표로 나눠서 5개까지, 1~10글자로 적어 주세요. 그 말만 했을 때 끝나요 ("끝이야", "됐어요" 처럼 끝에 붙는 말은 괜찮아요). 질문 속에 섞여 나오면 끝나지 않아요.</p>
</div>
<div class="row">
  <label class="title" for="wakeIdleMin">말이 없을 때 대화 끝내기</label>
  <select id="wakeIdleMin">
    <option value="1">1분 뒤</option><option value="3">3분 뒤</option><option value="5">5분 뒤</option><option value="10">10분 뒤</option><option value="0">끝내지 않기</option>
  </select>
  <p class="desc">호출어 방식에서 이만큼 말이 없으면 대화를 끝내고 다시 부를 때까지 기다려요.</p>
</div>

<h2>답 읽기</h2>
<div class="row">
  <label class="check"><input type="checkbox" id="summary"><span><b>긴 답은 요점만 읽기</b><br><span class="desc">긴 답은 앞부분 요점만 짧게 읽어요. 끄면 답 전체를 읽어요. 켜 둔 채로 "자세히 읽어 줘" 라고 하면 그 답만 전부 읽어요.</span></span></label>
</div>
<div class="row">
  <label class="check"><input type="checkbox" id="textOnly"><span><b>말로 물어도 답은 글로만</b><br><span class="desc">말로 물어본 질문의 답을 소리로 읽지 않고 화면에 글로만 보여 줘요. "글로만 보여 줘", "다시 말로 해 줘" 라고 말해도 돼요.</span></span></label>
</div>
<div class="row">
  <label class="check"><input type="checkbox" id="readTyped"><span><b>타이핑한 질문 답도 읽기</b><br><span class="desc">손으로 입력한 질문의 답도 소리로 읽어 줘요. 음성 대화를 켜지 않아도 되고, 마이크는 쓰지 않아요. 읽는 중에 멈추려면 오른쪽 아래 버튼을 누르세요.</span></span></label>
</div>

<h2>끼어들기</h2>
<div class="row">
  <label class="check"><input type="checkbox" id="barge"><span><b>읽는 중에 말하면 멈추고 듣기</b><br><span class="desc">답을 읽는 도중에 말하면 읽기를 멈추고 바로 들어요. 끄면 다 읽은 뒤에 말을 받아요. 스피커 소리가 마이크로 들어가면 저절로 멈출 수 있으니, 헤드셋을 쓸 때 켜는 게 좋아요.</span></span></label>
</div>

<h2>내 목소리</h2>
<div class="row">
  <div class="inline">
    <span class="pill" id="enrolled">등록 안 됨</span>
    <button id="enroll">내 목소리 등록 (15초)</button>
    <button class="secondary" id="unenroll">등록 지우기</button>
  </div>
  <p class="desc">15초 동안 평소처럼 말하면 그 목소리를 기억해서, 다른 사람 말이나 스피커 소리는 보내지 않아요. 등록하지 않으면 들리는 말을 모두 받아요. 등록하는 동안은 음성 대화가 켜져요.</p>
</div>
<div class="row">
  <label class="title" for="speakerMin">목소리 거르기 기준</label>
  <div class="inline">
    <input type="range" id="speakerMin" min="0.1" max="0.7" step="0.05">
    <span class="value" id="speakerMinValue"></span>
  </div>
  <p class="desc">등록한 목소리와 얼마나 비슷해야 받을지예요. 높을수록 다른 사람 말을 잘 거르지만 내 말도 가끔 놓칠 수 있어요. 보통은 0.4 가 알맞아요.</p>
</div>

<h2>장치</h2>
<div class="row">
  <div class="inline">
    <span class="title">마이크</span>
    <span class="pill" id="micDevice"></span>
    <button class="secondary" id="pickMic">고르기</button>
  </div>
  <p class="desc">말을 듣는 마이크예요. "윈도우 기본"이면 윈도우 소리 설정에서 고른 입력 장치를 따라가요. 고른 장치가 꺼져 있으면 윈도우 기본 장치로 들어요. 블루투스 이어폰은 켠 뒤 몇 초 지나야 소리가 들어와요.</p>
</div>
<div class="row">
  <div class="inline">
    <span class="title">소리 나올 곳</span>
    <span class="pill" id="outputDevice"></span>
    <button class="secondary" id="pickOutput">고르기</button>
  </div>
  <p class="desc">읽어 주는 소리가 나오는 장치예요. 블루투스 이어폰의 마이크를 쓰는 동안은 그 이어폰 소리가 전화 음질이 되니, 소리는 PC 스피커로 고르는 것도 방법이에요.</p>
</div>

<details>
<summary>고급</summary>
<div class="row">
  <label class="title">어느 음성을 쓸지</label>
  <label class="radio"><input type="radio" name="source" value="auto"><span><b>알아서</b><br><span class="desc">aglink 데스크톱 앱이 켜져 있으면 그 앱의 음성을, 아니면 이 확장의 엔진을 써요.</span></span></label>
  <label class="radio"><input type="radio" name="source" value="standalone"><span><b>늘 이 확장의 엔진</b><br><span class="desc">데스크톱 앱이 켜져 있어도 이 확장의 엔진과 위 설정을 써요.</span></span></label>
  <label class="radio"><input type="radio" name="source" value="desktop"><span><b>늘 데스크톱 앱</b><br><span class="desc">aglink 데스크톱 앱의 음성과 설정을 써요.</span></span></label>
</div>
<div class="row">
  <label class="title" for="enginePath">음성 엔진 위치</label>
  <input type="text" id="enginePath" placeholder="비워 두면 설치된 곳 (%LOCALAPPDATA%\\aglink-voice\\engine\\aglink-voice-engine.exe)">
</div>
<div class="row">
  <label class="title" for="engineRoot">모델 폴더</label>
  <input type="text" id="engineRoot" placeholder="비워 두면 엔진 폴더의 위">
  <p class="desc">받아쓰기·읽기 모델(models)과 받아쓰기 프로그램(whisper)이 든 폴더예요. 설치 파일로 깔았다면 비워 두세요.</p>
</div>
</details>

<h2>말로 바꾸기</h2>
<p class="desc">음성 대화 중에 이렇게 말하면 설정이 바로 바뀌어요.</p>
<table class="desc">
  <tr><td>여자 3번 목소리로 바꿔 줘</td><td>목소리</td></tr>
  <tr><td>좀 더 천천히 / 빨리 읽어 줘 / 속도 원래대로</td><td>빠르기</td></tr>
  <tr><td>자세히 읽어 줘 / 요약해서 읽어 줘 / 다시 읽어 줘</td><td>방금 답 다시 읽기</td></tr>
  <tr><td>글로만 보여 줘 / 다시 말로 해 줘</td><td>글로만 답하기</td></tr>
  <tr><td>끼어들기 켜 줘 / 꺼 줘</td><td>끼어들기</td></tr>
  <tr><td>잠깐</td><td>읽기 멈춤</td></tr>
  <tr><td>인식 멈춰 / 다시 인식해</td><td>듣기 잠시 멈춤 (멈춘 동안은 "다시 인식해"와 "마이크 꺼"만 받아요)</td></tr>
  <tr><td>마이크 꺼</td><td>음성 끄기 (다시 켜기는 Ctrl+Alt+V)</td></tr>
  <tr><td>새 대화 시작해 줘</td><td>Claude Code 새 대화</td></tr>
  <tr><td>부르는 이름을 자비스로 바꿔 줘</td><td>호출어</td></tr>
  <tr><td>목소리 등록해 줘 / 목소리 등록 해제해 줘</td><td>내 목소리</td></tr>
</table>
<p class="desc"><a id="native">VS Code 기본 설정 화면에서 보기</a></p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const set = (key, value) => vscode.postMessage({ type: "set", key, value });
  const fmt = (v, d) => Number(v).toFixed(d);

  $("voice").addEventListener("change", (e) => set("voice", e.target.value));
  $("speed").addEventListener("input", (e) => ($("speedValue").textContent = fmt(e.target.value, 2) + "배"));
  $("speed").addEventListener("change", (e) => set("speed", Number(e.target.value)));
  $("speedReset").addEventListener("click", () => set("speed", 0.98));
  $("speakerMin").addEventListener("input", (e) => ($("speakerMinValue").textContent = fmt(e.target.value, 2)));
  $("speakerMin").addEventListener("change", (e) => set("speakerMin", Number(e.target.value)));
  $("wakeIdleMin").addEventListener("change", (e) => set("wakeIdleMin", Number(e.target.value)));
  for (const id of ["wakeDefault", "stopDefault", "summary", "textOnly", "readTyped", "barge"]) $(id).addEventListener("change", (e) => set(id, e.target.checked));
  for (const name of ["listenMode", "source"])
    for (const r of document.querySelectorAll('input[name="' + name + '"]')) r.addEventListener("change", (e) => e.target.checked && set(name, e.target.value));
  for (const id of ["wakeNames", "stopWords", "enginePath", "engineRoot"]) $(id).addEventListener("change", (e) => set(id, e.target.value));
  for (const id of ["toggle", "preview", "enroll", "unenroll", "native", "pickMic", "pickOutput"]) $(id).addEventListener("click", () => vscode.postMessage({ type: id }));

  window.addEventListener("message", ({ data: m }) => {
    if (m.type !== "state") return;
    const v = m.values;
    $("voice").value = v.voice;
    $("speed").value = v.speed;
    $("speedValue").textContent = fmt(v.speed, 2) + "배";
    $("speakerMin").value = v.speakerMin;
    $("speakerMinValue").textContent = fmt(v.speakerMin, 2);
    $("wakeIdleMin").value = String(v.wakeIdleMin);
    for (const id of ["wakeDefault", "stopDefault", "summary", "textOnly", "readTyped", "barge"]) $(id).checked = !!v[id];
    for (const name of ["listenMode", "source"])
      for (const r of document.querySelectorAll('input[name="' + name + '"]')) r.checked = r.value === v[name];
    for (const id of ["wakeNames", "stopWords", "enginePath", "engineRoot"]) {
      if (document.activeElement === $(id)) continue; // not under the cursor
      $(id).value = Array.isArray(v[id]) ? v[id].join(", ") : v[id] || "";
    }
    $("micDevice").textContent = v.micDevice || "윈도우 기본";
    $("outputDevice").textContent = v.outputDevice || "윈도우 기본";
    $("onState").textContent = m.on ? "음성 켜짐" : "음성 꺼짐";
    $("toggle").textContent = m.on ? "음성 대화 끄기" : "음성 대화 켜기";
    $("enrolled").textContent = m.enrolled ? "목소리 등록됨" : "등록 안 됨";
    $("unenroll").disabled = !m.enrolled;
    $("desktopBanner").hidden = !m.desktop;
  });
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}

module.exports = { openSettings };
