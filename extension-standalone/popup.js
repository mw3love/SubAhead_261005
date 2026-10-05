// 팝업 화면: 키 입력 / 준비 / 진행 중 / 완료 / 오류 다섯 상태를 그린다.
const STEPS = [
  ["download", "영상 받기"],
  ["extract", "소리만 뽑기"],
  ["upload", "올리기"],
  ["transcribe", "받아 적기"],
];
const main = document.getElementById("main");
let tabId, info;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? h + "시간 " + m + "분" : m ? m + "분 " + r + "초" : r + "초";
};
const fmtNum = (n) => Math.round(n).toLocaleString("ko-KR");

function renderKey(error) {
  main.innerHTML = `
    <h2>시작하려면 키가 필요해요</h2>
    <p>JBNU 게이트웨이 API 키를 넣어 주세요. 키는 이 브라우저에만 저장돼요.</p>
    <label for="key" hidden>API 키</label>
    <input id="key" type="password" placeholder="API 키 붙여넣기" autocomplete="off">
    <button id="save">저장하고 시작하기</button>
    ${error ? `<p class="warn" role="alert">${esc(error)}</p>` : ""}`;
  const input = document.getElementById("key");
  input.focus();
  const save = async () => {
    const btn = document.getElementById("save");
    btn.disabled = true;
    btn.textContent = "확인 중…";
    const r = await chrome.runtime.sendMessage({ type: "saveKey", apiKey: input.value.trim() });
    if (r.ok) load();
    else renderKey(r.message);
  };
  document.getElementById("save").onclick = save;
  input.onkeydown = (e) => e.key === "Enter" && save();
}

function renderReady() {
  if (!info.url) {
    main.innerHTML = `
      <h2>영상을 찾지 못했어요</h2>
      <p>영상이 있는 페이지에서 영상을 잠깐 재생한 뒤 다시 눌러 주세요.</p>
      <button id="again" class="sub">다시 찾기</button>`;
    document.getElementById("again").onclick = load;
    return;
  }
  if (info.cached) {
    main.innerHTML = `
      <div class="card"><div class="row"><span>저장된 자막</span><span>있음</span></div>
      <div class="row"><span>비용</span><span>들지 않아요</span></div></div>
      <button id="go">자막 불러오기</button>`;
  } else {
    const short = info.estimate != null && info.remaining != null && info.estimate > info.remaining;
    main.innerHTML = `
      <div class="card">
        <div class="row"><span>영상 길이</span><span>${info.duration ? fmtDur(info.duration) : "알 수 없음"}</span></div>
        <div class="row"><span>예상 비용</span><span>${info.estimate != null ? "약 " + fmtNum(info.estimate) + " 크레딧" : "알 수 없음"}</span></div>
        ${short ? `<div class="warn">남은 크레딧이 모자라요.</div>` : ""}
      </div>
      <button id="go" ${short ? "disabled" : ""}>전체 자막 만들기</button>`;
  }
  document.getElementById("go").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId });
}

function renderRunning(job) {
  const now = STEPS.findIndex(([k]) => k === job.stage);
  const secs = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
  main.innerHTML = `
    <h2>자막을 만들고 있어요</h2>
    <ul class="steps">${STEPS.map(([k, label], i) => {
      const cls = i < now ? "done" : i === now ? "now" : "";
      const mark = i < now ? "✓" : "";
      const detail = i === now && job.detail ? `<small>${esc(job.detail)}</small>` : "";
      return `<li class="${cls}"><i>${mark}</i>${label}${detail}</li>`;
    }).join("")}</ul>
    <p>${secs}초 지났어요. 팝업을 닫아도 계속 진행돼요.</p>`;
}

function renderDone(job) {
  main.innerHTML = `
    <div class="big" aria-hidden="true">✓</div>
    <h2>${esc(job.message)}</h2>
    <p>${job.credits ? fmtNum(job.credits) + " 크레딧을 썼어요. " : ""}영상을 아무 데나 넘겨 보세요.</p>`;
}

function renderError(job) {
  const buttons =
    job.action === "retry" ? `<button id="retry">다시 시도</button>` :
    job.action === "key" ? `<button id="rekey">키 다시 넣기</button>` : "";
  main.innerHTML = `
    <div class="card error" role="alert">${esc(job.message)}
      ${job.detail ? `<details><summary>자세히</summary>${esc(job.detail)}</details>` : ""}</div>
    ${buttons}`;
  const retry = document.getElementById("retry");
  if (retry) retry.onclick = () => chrome.runtime.sendMessage({ type: "start", tabId });
  const rekey = document.getElementById("rekey");
  if (rekey) rekey.onclick = () => renderKey();
}

function render() {
  const credits = document.getElementById("credits");
  if (info.remaining != null) {
    credits.hidden = false;
    credits.textContent = "남은 " + fmtNum(info.remaining);
  }
  const job = info.job;
  // 다른 영상으로 옮겨 간 뒤의 지난 결과는 보여 주지 않는다(진행 중은 항상 보여 줌).
  const sameVideo = job && (!job.url || !info.url || job.url === info.url);
  if (!info.hasKey && !(job && job.status === "running")) return renderKey();
  if (job && job.status === "running") return renderRunning(job);
  if (job && sameVideo && job.status === "error") return renderError(job);
  if (job && sameVideo && job.status === "done") return renderDone(job);
  renderReady();
}

async function load() {
  info = await chrome.runtime.sendMessage({ type: "info", tabId });
  render();
}

(async () => {
  // ?tab= 은 화면 시험용(팝업을 일반 탭으로 열 때). 평소에는 지금 보고 있는 탭.
  const param = new URLSearchParams(location.search).get("tab");
  tabId = param ? +param : (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
  await load();
  chrome.storage.session.onChanged.addListener((ch) => {
    const c = ch["job:" + tabId];
    if (!c) return;
    info.job = c.newValue;
    render();
  });
  setInterval(() => info && info.job && info.job.status === "running" && render(), 1000);
  document.getElementById("opt").onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };
})();
