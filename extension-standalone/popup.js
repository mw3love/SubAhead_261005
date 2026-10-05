// 팝업 화면: 키 입력 / 준비 / 진행 중 / 완료 / 오류 다섯 상태를 그린다.
// 화면 글자는 _locales 의 문구를 쓴다(브라우저 언어에 따라 한국어/영어).
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));
const STEPS = [
  ["download", t("stepDownload")],
  ["extract", t("stepExtract")],
  ["upload", t("stepUpload")],
  ["transcribe", t("stepTranscribe")],
];
const main = document.getElementById("main");
let tabId, info;

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? t("durH", h, m) : m ? t("durM", m, r) : t("durS", r);
};
const fmtNum = (n) => Math.round(n).toLocaleString(chrome.i18n.getUILanguage());

function renderKey(error) {
  main.innerHTML = `
    <h2>${t("popupKeyTitle")}</h2>
    <p>${t("popupKeyDesc")}</p>
    <label for="baseurl" class="lbl">${t("baseUrlLabel")}</label>
    <input id="baseurl" type="url" placeholder="${t("baseUrlPlaceholder")}" value="${esc(info && info.baseUrl)}" autocomplete="off" spellcheck="false">
    <label for="key" class="lbl">${t("apiKeyLabel")}</label>
    <input id="key" type="password" placeholder="${t("keyPlaceholder")}" autocomplete="off">
    <button id="save">${t("saveAndStart")}</button>
    ${error ? `<p class="warn" role="alert">${esc(error)}</p>` : ""}`;
  const input = document.getElementById("key");
  const urlInput = document.getElementById("baseurl");
  (urlInput.value ? input : urlInput).focus();
  const save = async () => {
    const btn = document.getElementById("save");
    btn.disabled = true;
    btn.textContent = t("checking");
    const r = await chrome.runtime.sendMessage({ type: "saveKey", baseUrl: urlInput.value.trim(), apiKey: input.value.trim() });
    if (r.ok) load();
    else renderKey(r.message);
  };
  document.getElementById("save").onclick = save;
  input.onkeydown = (e) => e.key === "Enter" && save();
}

function renderReady() {
  if (!info.url) {
    main.innerHTML = `
      <h2>${t("noVideoTitle")}</h2>
      <p>${t("noVideoDesc")}</p>
      <button id="again" class="sub">${t("findAgain")}</button>`;
    document.getElementById("again").onclick = load;
    return;
  }
  if (info.live) {
    main.innerHTML = `
      <h2>${t("liveTitle")}</h2>
      <p>${t("liveDesc")}</p>`;
    return;
  }
  if (info.cached) {
    main.innerHTML = `
      <div class="card"><div class="row"><span>${t("savedSubs")}</span><span>${t("available")}</span></div>
      <div class="row"><span>${t("cost")}</span><span>${t("free")}</span></div></div>
      <button id="go">${t("loadSubs")}</button>`;
  } else {
    const short = info.estimate != null && info.remaining != null && info.estimate > info.remaining;
    main.innerHTML = `
      <div class="card">
        <div class="row"><span>${t("videoLength")}</span><span>${info.duration ? fmtDur(info.duration) : t("unknown")}</span></div>
        ${info.estimate != null ? `<div class="row"><span>${t("estCost")}</span><span>${t("aboutCredits", fmtNum(info.estimate))}</span></div>` : ""}
        ${short ? `<div class="warn">${t("notEnough")}</div>` : ""}
      </div>
      <button id="go" ${short ? "disabled" : ""}>${t("makeAll")}</button>`;
  }
  document.getElementById("go").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId });
}

function renderRunning(job) {
  const now = STEPS.findIndex(([k]) => k === job.stage);
  const secs = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
  main.innerHTML = `
    <h2>${t("makingTitle")}</h2>
    <ul class="steps">${STEPS.map(([k, label], i) => {
      const cls = i < now ? "done" : i === now ? "now" : "";
      const mark = i < now ? "✓" : "";
      const detail = i === now && job.detail ? `<small>${esc(job.detail)}</small>` : "";
      return `<li class="${cls}"><i>${mark}</i>${label}${detail}</li>`;
    }).join("")}</ul>
    <p>${t("elapsed", secs)}</p>`;
}

function renderDone(job) {
  main.innerHTML = `
    <div class="big" aria-hidden="true">✓</div>
    <h2>${esc(job.message)}</h2>
    <p>${job.credits ? t("creditsUsed", fmtNum(job.credits)) + " " : ""}${t("seekAnywhere")}</p>`;
}

function renderError(job) {
  const buttons =
    job.action === "retry" ? `<button id="retry">${t("retry")}</button>` :
    job.action === "key" ? `<button id="rekey">${t("rekey")}</button>` : "";
  main.innerHTML = `
    <div class="card error" role="alert">${esc(job.message)}
      ${job.detail ? `<details><summary>${t("details")}</summary>${esc(job.detail)}</details>` : ""}</div>
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
    credits.textContent = t("remaining", fmtNum(info.remaining));
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
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.getElementById("title").textContent = t("extName");
  document.getElementById("opt").textContent = t("settings");
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
