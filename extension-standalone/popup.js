// 팝업(항상 다크). [자막] 탭: 상태(키 입력·준비·진행 중·완료·오류) + 자막 미리보기·크기·색·배경.
// [설정] 탭: API 게이트웨이 · 저장된 자막 · Alt+휠 · 단축키. 따로 있던 설정 페이지를 여기에 합쳤다.
// 화면 글자는 _locales 의 문구를 쓴다(브라우저 언어에 따라 한국어/영어).
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));
const $ = (id) => document.getElementById(id);
const STEPS = [
  ["download", t("stepDownload")],
  ["extract", t("stepExtract")],
  ["upload", t("stepUpload")],
  ["transcribe", t("stepTranscribe")],
];
const main = $("main");
let tabId, info, style = MiriStyle.normalize();

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const lang = chrome.i18n.getUILanguage();
const fmtNum = (n) => Math.round(n).toLocaleString(lang);
const fmtDur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? t("durH", h, m) : m ? t("durM", m, r) : t("durS", r);
};
const fmtTime = (sec) => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = String(sec % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + r : m + ":" + r;
};
const fmtSize = (b) => (b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1024 / 1024).toFixed(1) + " MB");

// ---------- 탭 ----------
function showTab(name) {
  for (const [tab, panel] of [["tab-subs", "panel-subs"], ["tab-settings", "panel-settings"]]) {
    const on = tab === "tab-" + name;
    $(tab).setAttribute("aria-selected", String(on));
    $(panel).hidden = !on;
  }
}

// ---------- [자막] 탭: 상태 ----------
function keyFormHtml(error) {
  return `
    <h2>${t("popupKeyTitle")}</h2>
    <p>${t("popupKeyDesc")}</p>
    <label for="baseurl" class="lbl">${t("baseUrlLabel")}</label>
    <input id="baseurl" type="url" placeholder="${t("baseUrlPlaceholder")}" value="${esc(info && info.baseUrl)}" autocomplete="off" spellcheck="false">
    <label for="key" class="lbl">${t("apiKeyLabel")}</label>
    <input id="key" type="password" placeholder="${t("keyPlaceholder")}" autocomplete="off">
    <button id="save">${t("saveAndStart")}</button>
    ${error ? `<p class="warn" role="alert">${esc(error)}</p>` : ""}`;
}

function renderKey(error) {
  main.innerHTML = keyFormHtml(error);
  const input = $("key"), urlInput = $("baseurl");
  (urlInput.value ? input : urlInput).focus();
  const save = async () => {
    $("save").disabled = true;
    $("save").textContent = t("checking");
    const r = await chrome.runtime.sendMessage({ type: "saveKey", baseUrl: urlInput.value.trim(), apiKey: input.value.trim() });
    if (r.ok) load();
    else renderKey(r.message);
  };
  $("save").onclick = save;
  input.onkeydown = (e) => e.key === "Enter" && save();
}

function renderReady() {
  if (!info.url) {
    main.innerHTML = `
      <h2>${t("noVideoTitle")}</h2>
      <p>${t("noVideoDesc")}</p>
      <button id="again" class="sub">${t("findAgain")}</button>`;
    $("again").onclick = load;
    return;
  }
  if (info.live) {
    main.innerHTML = `<h2>${t("liveTitle")}</h2><p>${t("liveDesc")}</p>`;
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
  $("go").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId });
}

function renderRunning(job) {
  const now = STEPS.findIndex(([k]) => k === job.stage);
  const secs = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
  main.innerHTML = `
    <h2>${t("makingTitle")}</h2>
    <ul class="steps">${STEPS.map(([k, label], i) => {
      const cls = i < now ? "done" : i === now ? "now" : "";
      const detail = i === now && job.detail ? `<small>${esc(job.detail)}</small>` : "";
      return `<li class="${cls}"><i>${i < now ? "✓" : ""}</i>${label}${detail}</li>`;
    }).join("")}</ul>
    <p style="margin:0">${t("elapsed", secs)}</p>`;
}

function renderDone(job) {
  const remakeLabel = info.estimate != null ? t("remakeCost", fmtNum(info.estimate)) : t("remake");
  main.innerHTML = `
    <div class="status"><span class="dot"></span>${esc(job.message)}</div>
    <p style="margin:0">${job.credits ? t("creditsUsed", fmtNum(job.credits)) + " " : ""}${t("seekAnywhere")}</p>
    <div class="pair">
      <button class="sub" id="toggle">${t("toggleSubs")}</button>
      <button class="sub" id="remake">${remakeLabel}</button>
    </div>`;
  $("toggle").onclick = () => chrome.tabs.sendMessage(tabId, { type: "command", name: "toggle" }).catch(() => {});
  $("remake").onclick = () => chrome.runtime.sendMessage({ type: "remake", tabId });
}

function renderError(job) {
  const buttons =
    job.action === "retry" ? `<button id="retry">${t("retry")}</button>` :
    job.action === "key" ? `<button id="rekey">${t("rekey")}</button>` : "";
  main.innerHTML = `
    <div class="card error" role="alert">${esc(job.message)}
      ${job.detail ? `<details><summary>${t("details")}</summary>${esc(job.detail)}</details>` : ""}</div>
    ${buttons}`;
  if ($("retry")) $("retry").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId });
  if ($("rekey")) $("rekey").onclick = () => renderKey();
}

function render() {
  const credits = $("credits");
  credits.hidden = info.remaining == null;
  if (info.remaining != null) credits.textContent = t("remaining", fmtNum(info.remaining));
  $("look").hidden = $("foot").hidden = !info.hasKey;
  const job = info.job;
  // 다른 영상으로 옮겨 간 뒤의 지난 결과는 보여 주지 않는다(진행 중은 항상 보여 줌).
  const sameVideo = job && (!job.url || !info.url || job.url === info.url);
  if (!info.hasKey && !(job && job.status === "running")) return renderKey();
  if (job && job.status === "running") return renderRunning(job);
  if (job && sameVideo && job.status === "error") return renderError(job);
  if (job && sameVideo && job.status === "done") return renderDone(job);
  renderReady();
}

// ---------- [자막] 탭: 모양(미리보기·크기·색·배경) ----------
// 바꾸면 설정(style)에 저장하고, 열린 영상의 자막은 설정 변경을 받아 바로 다시 그린다.
function renderLook() {
  $("pvtext").style.cssText = MiriStyle.preview(style);
  $("size").value = style.size;
  $("sizeval").textContent = style.size;
  $("size").style.background = `linear-gradient(90deg, var(--accent) 0 ${style.size}%, var(--line2) ${style.size}% 100%)`;
  for (const b of document.querySelectorAll("[data-color]")) b.setAttribute("aria-pressed", String(b.dataset.color === style.color));
  for (const b of document.querySelectorAll("[data-bg]")) b.setAttribute("aria-pressed", String(b.dataset.bg === style.bg));
  $("wheel").checked = style.wheel;
}
function saveStyle(patch) {
  style = MiriStyle.normalize({ ...style, ...patch });
  renderLook();
  chrome.storage.local.set({ style });
}

// ---------- [설정] 탭 ----------
async function renderConn() {
  const { baseUrl, apiKey } = await chrome.storage.local.get(["baseUrl", "apiKey"]);
  const ok = !!(baseUrl && apiKey);
  $("conndot").classList.toggle("off", !ok);
  $("connhost").textContent = ok ? t("keySaved", new URL(baseUrl).host, apiKey.slice(-4)) : t("keyNone");
  if (baseUrl && !$("s-baseurl").value) $("s-baseurl").value = baseUrl;
}

async function renderSaved() {
  const all = await chrome.storage.local.get(null);
  const urls = Object.keys(all).filter((k) => k.startsWith("cues:")).map((k) => k.slice(5));
  const items = urls.map((url) => {
    const meta = all["meta:" + url] || {};
    const cues = all["cues:" + url] || [];
    return { url, meta, lines: meta.lines || cues.length, duration: meta.duration || (cues.length ? cues[cues.length - 1].end : 0),
             sync: all["sync:" + url] || 0, createdAt: meta.createdAt || 0 };
  }).sort((a, b) => b.createdAt - a.createdAt);
  const used = items.length ? await chrome.storage.local.getBytesInUse(urls.flatMap((u) => ["cues:" + u, "meta:" + u, "sync:" + u])) : 0;
  $("savedsum").textContent = items.length ? t("savedCount", items.length, fmtSize(used)) : "";
  $("clearall").hidden = !items.length;
  if (!items.length) {
    $("saved").innerHTML = `<li class="empty">${t("savedEmpty")}</li>`;
    return;
  }
  const trash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;
  $("saved").innerHTML = items.map((it, i) => {
    let title = it.meta.title;
    if (!title) {
      try { const u = new URL(it.url); title = u.hostname + u.pathname; } catch { title = it.url; }
    }
    const parts = [t("lines", it.lines), fmtTime(it.duration)];
    if (it.createdAt) parts.push(new Date(it.createdAt).toLocaleDateString(lang));
    if (it.sync) parts.push(t("syncShort", (it.sync > 0 ? "+" : "−") + Math.abs(it.sync).toFixed(1)));
    return `<li><div class="info"><div class="title" title="${esc(it.url)}">${esc(title)}</div>
      <div class="meta">${esc(parts.join(" · "))}</div></div>
      <button class="del" data-i="${i}" aria-label="${esc(t("deleteAria", title))}">${trash}</button></li>`;
  }).join("");
  for (const btn of $("saved").querySelectorAll("button[data-i]")) {
    const url = items[+btn.dataset.i].url;
    btn.onclick = () => chrome.storage.local.remove(["cues:" + url, "meta:" + url, "sync:" + url]);
  }
}

// 모두 지우기: 실수 방지로 두 번 눌러야 지워진다(4초 안에 다시 누르기)
let clearArmed = null;
async function clearAll() {
  const btn = $("clearall");
  if (!clearArmed) {
    btn.textContent = t("clearConfirm");
    clearArmed = setTimeout(() => { clearArmed = null; btn.textContent = t("clearAll"); }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = t("clearAll");
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => /^(cues|meta|sync):/.test(k));
  await chrome.storage.local.remove(keys);
}

async function saveConn() {
  const msg = $("keymsg");
  msg.className = "";
  msg.textContent = t("checking");
  const r = await chrome.runtime.sendMessage({ type: "saveKey", baseUrl: $("s-baseurl").value.trim(), apiKey: $("s-key").value.trim() });
  msg.className = r.ok ? "ok" : "err";
  msg.textContent = r.ok ? t("keySavedOk") : "✗ " + r.message;
  if (r.ok) {
    $("s-key").value = "";
    load();
  }
}

// ---------- 시작 ----------
async function load() {
  info = await chrome.runtime.sendMessage({ type: "info", tabId });
  render();
  renderConn();
}

(async () => {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));
  $("preview").setAttribute("aria-label", t("preview"));

  $("tab-subs").onclick = () => showTab("subs");
  $("tab-settings").onclick = () => showTab("settings");
  $("size").oninput = () => saveStyle({ size: +$("size").value });
  for (const b of document.querySelectorAll("[data-color]")) b.onclick = () => saveStyle({ color: b.dataset.color });
  for (const b of document.querySelectorAll("[data-bg]")) b.onclick = () => saveStyle({ bg: b.dataset.bg });
  $("wheel").onchange = () => saveStyle({ wheel: $("wheel").checked });
  $("connchange").onclick = () => { $("keyform").hidden = !$("keyform").hidden; };
  $("s-save").onclick = saveConn;
  $("clearall").onclick = clearAll;
  $("shortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

  // ?tab= 은 화면 시험용(팝업을 일반 탭으로 열 때). 평소에는 지금 보고 있는 탭.
  const param = new URLSearchParams(location.search).get("tab");
  tabId = param ? +param : (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
  style = MiriStyle.normalize((await chrome.storage.local.get("style")).style);
  renderLook();
  renderSaved();
  await load();

  chrome.storage.session.onChanged.addListener((ch) => {
    const c = ch["job:" + tabId];
    if (!c) return;
    info.job = c.newValue;
    render();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.style) {
      style = MiriStyle.normalize(ch.style.newValue);
      renderLook();
    }
    if (Object.keys(ch).some((k) => /^(cues|meta|sync):/.test(k))) renderSaved();
    if (ch.apiKey || ch.baseUrl) renderConn();
  });
  setInterval(() => info && info.job && info.job.status === "running" && render(), 1000);
})();
