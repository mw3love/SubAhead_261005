// 팝업(항상 다크). [자막] 탭: 이 페이지 영상의 만들기 전(상태·체크 목록)과 만든 후(SRT·TXT·복사·다시 만들기·지우기).
// [보관함] 탭: 지금까지 만든 모든 자막. [모양] 탭: 미리보기·크기·색·배경. [설정] 탭: API 게이트웨이 · TXT 모양 · Alt+휠 · 단축키.
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
const unchecked = new Set(); // 영상이 여러 개일 때 체크를 뺀 영상 주소(기본은 모두 체크)
let opened = null; // 영상 목록에서 ⋯ 로 펼친 영상 주소
let libQuery = ""; // 보관함 제목 찾기

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
  for (const [tab, panel] of [["tab-subs", "panel-subs"], ["tab-lib", "panel-lib"], ["tab-look", "panel-look"], ["tab-settings", "panel-settings"]]) {
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
  input.onkeydown = (e) => { if (e.key === "Enter") save(); };
}

// 영상이 하나일 때(또는 고를 영상 목록이 없을 때)의 화면들. note: 맨 위에 붙일 한 줄(예: 취소했어요)
function renderReady(note) {
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
  const top = note ? `<p>${esc(note)}</p>` : "";
  if (info.cached) {
    main.innerHTML = `${top}
      <div class="card"><div class="row"><span>${t("savedSubs")}</span><span>${t("available")}</span></div>
      <div class="row"><span>${t("cost")}</span><span>${t("free")}</span></div></div>
      <button id="go">${t("loadSubs")}</button>
      ${saveBar()}`;
    bindGet(main, info.url);
  } else {
    const short = info.estimate != null && info.remaining != null && info.estimate > info.remaining;
    main.innerHTML = `${top}
      <div class="card">
        <div class="row"><span>${t("videoLength")}</span><span>${info.duration ? fmtDur(info.duration) : t("unknown")}</span></div>
        ${info.estimate != null ? `<div class="row"><span>${t("estCost")}</span><span>${t("aboutCredits", fmtNum(info.estimate))}</span></div>` : ""}
        ${short ? `<div class="warn">${t("notEnough")}</div>` : ""}
      </div>
      <button id="go" ${short ? "disabled" : ""}>${t("makeAll")}</button>`;
  }
  $("go").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId, srcs: [info.url] });
}

// 영상 여러 개를 만들 때 영상마다 보여 줄 상태
const ITEM_STAGE = {
  wait: t("stageWaiting"), download: t("stageDownload"), extract: t("stageExtract"), queued: t("stageQueued"),
  upload: t("stageUpload"), transcribe: t("stageTranscribe"), done: t("toastDone"), failed: t("toastFailed"),
};

function renderRunning(job) {
  const secs = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
  let body;
  if (job.items && job.items.length > 1) {
    // 영상별 상태 목록(번호는 영상 목록과 같은 페이지 순서)
    const done = job.items.filter((it) => it.stage === "done" || it.stage === "failed").length;
    body = `<h2>${t("makingTitle")} ${t("nthOf", done, job.items.length)}</h2>
      <ul class="steps items">${job.items.map((it, n) => {
        // 도는 표시는 실제로 일하는 영상에만(차례를 기다리는 영상은 빈 동그라미)
        const cls = it.stage === "done" ? "done" : it.stage === "failed" ? "fail" : it.stage === "wait" || it.stage === "queued" ? "" : "now";
        const mark = it.stage === "done" ? "✓" : it.stage === "failed" ? "!" : "";
        const detail = cls === "now" && it.detail ? ` · ${esc(it.detail)}` : "";
        return `<li class="${cls}"><i>${mark}</i>${t("videoN", videoNo(it.url, n))}<small>${ITEM_STAGE[it.stage] || ""}${detail}</small></li>`;
      }).join("")}</ul>`;
  } else {
    const now = STEPS.findIndex(([k]) => k === job.stage);
    body = `<h2>${t("makingTitle")}</h2>
      <ul class="steps">${STEPS.map(([k, label], i) => {
        const cls = i < now ? "done" : i === now ? "now" : "";
        const detail = i === now && job.detail ? `<small>${esc(job.detail)}</small>` : "";
        return `<li class="${cls}"><i>${i < now ? "✓" : ""}</i>${label}${detail}</li>`;
      }).join("")}</ul>`;
  }
  main.innerHTML = `${body}
    <p>${t("elapsed", secs)}</p>
    <button class="sub" id="cancel">${t("cancel")}</button>
    <p class="note">${t("cancelNote")}</p>`;
  $("cancel").onclick = () => {
    $("cancel").disabled = true;
    chrome.runtime.sendMessage({ type: "cancel", tabId });
  };
}

function renderDone(job) {
  const remakeLabel = info.estimate != null ? t("remakeCost", fmtNum(info.estimate)) : t("remake");
  main.innerHTML = `
    <div class="status"><span class="dot"></span>${esc(job.message)}</div>
    <p style="margin:0">${job.credits ? t("creditsUsed", fmtNum(job.credits)) + " " : ""}${t("seekAnywhere")}</p>
    <div class="pair">
      <button class="sub" id="toggle">${t("toggleSubs")}</button>
      <button class="sub" id="remake">${remakeLabel}</button>
    </div>
    ${saveBar()}`;
  bindGet(main, job.url || info.url);
  $("toggle").onclick = () => chrome.tabs.sendMessage(tabId, { type: "command", name: "toggle" }).catch(() => {});
  $("remake").onclick = () => chrome.runtime.sendMessage({ type: "remake", tabId, srcs: [info.url] });
}

function renderError(job) {
  const buttons =
    job.action === "retry" ? `<button id="retry">${t("retry")}</button>` :
    job.action === "key" ? `<button id="rekey">${t("rekey")}</button>` : "";
  main.innerHTML = `
    <div class="card error" role="alert">${esc(job.message)}
      ${job.detail ? `<details><summary>${t("details")}</summary>${esc(job.detail)}</details>` : ""}</div>
    ${buttons}`;
  if ($("retry")) $("retry").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId, srcs: [job.url || info.url] });
  if ($("rekey")) $("rekey").onclick = () => renderKey();
}

function render() {
  const credits = $("credits");
  credits.hidden = info.remaining == null;
  if (info.remaining != null) credits.textContent = t("remaining", fmtNum(info.remaining));
  const job = info.job;
  if (!info.hasKey && !(job && job.status === "running")) return renderKey();
  if (job && job.status === "running") return renderRunning(job);
  if (info.videos) return renderMulti(job);
  // 다른 영상으로 옮겨 간 뒤의 지난 결과는 보여 주지 않는다(진행 중은 항상 보여 줌).
  const sameVideo = job && (!job.url || !info.url || job.url === info.url);
  if (job && sameVideo && job.status === "error") renderError(job);
  else if (job && sameVideo && job.status === "done") renderDone(job);
  else renderReady(job && sameVideo && job.status === "cancelled" ? t("jobCancelled") : "");
}

// 영상 목록에서의 번호(1부터). 목록에 없으면 작업 안의 순서.
const videoNo = (url, n) => {
  const k = info.videos ? info.videos.findIndex((v) => v.src === url) : -1;
  return k >= 0 ? k + 1 : n + 1;
};

// ---------- [자막] 탭: 영상이 여러 개일 때 ----------
// 지난 결과(있으면) + 영상 체크 목록(기본 모두 체크, 빼고 싶은 것만 끈다) + 합계 + 만들기 버튼.
// 목록에 마우스를 올리거나 키보드로 옮기면 페이지의 그 영상에 테두리를 친다.
function renderMulti(job) {
  const vids = info.videos;
  const mine = job && job.urls && job.urls.some((u) => vids.some((v) => v.src === u));
  const failed = mine && job.failed && job.failed.length ? job.failed.map((f) => f.url) : [];
  let head = "";
  if (mine && job.status === "done")
    head = `<div class="status"><span class="dot"></span>${esc(job.message)}</div>
      <p>${job.credits ? t("creditsUsed", fmtNum(job.credits)) + " " : ""}${t("seekAnywhere")}</p>`;
  if (mine && job.status === "error")
    head = `<div class="card error" role="alert">${esc(job.message)}
      ${job.detail ? `<details><summary>${t("details")}</summary>${esc(job.detail)}</details>` : ""}</div>`;
  if (mine && job.status === "cancelled") head = `<p>${t("jobCancelled")}</p>`;
  if (failed.length) head += `<button class="sub" id="retryfailed">${t("retryFailed", failed.length)}</button>`;
  if (mine && job.status === "error" && job.action === "key") head += `<button class="sub" id="rekey">${t("rekey")}</button>`;
  if (head) head = `<div class="result">${head}</div>`;

  const chosen = vids.filter((v) => !unchecked.has(v.src));
  const todo = chosen.filter((v) => !v.cached);
  const known = todo.every((v) => v.estimate != null);
  const cost = todo.reduce((sum, v) => sum + (v.estimate || 0), 0);
  const short = known && info.remaining != null && cost > info.remaining;
  const allOn = chosen.length === vids.length;
  const go = !chosen.length ? t("pickNone") : todo.length ? t("makeN", todo.length) : t("loadSubs");
  main.innerHTML = `${head}
    <div class="listhead"><h3 id="picklbl">${t("thisPageVideos")}</h3>
      <button class="link" id="checkall">${allOn ? t("uncheckAll") : t("checkAll")}</button></div>
    <div class="picker" role="group" aria-labelledby="picklbl">${vids.map((v, n) => `
      <label class="pick${opened === v.src ? " open" : ""}" data-n="${n}">
        <input type="checkbox" ${unchecked.has(v.src) ? "" : "checked"}>
        <span class="name">${t("videoN", n + 1)}${v.src === info.played ? ` <small>· ${t("lastPlayed")}</small>` : ""}</span>
        <span class="meta">${v.duration ? fmtTime(v.duration) : ""}</span>
        ${v.cached ? `<span class="fmt">${getButtons()}<button class="mini" data-more aria-expanded="${opened === v.src}" aria-label="${t("more")}">⋯</button></span>` : ""}
      </label>
      ${v.cached && opened === v.src ? `<div class="morebox" data-n="${n}">
        <button class="mini" data-get="copy">${t("copy")}</button>
        <button class="mini" data-remake>${v.estimate != null ? t("remakeCost", fmtNum(v.estimate)) : t("remake")}</button>
        <button class="mini warnbtn" data-del>${t("deleteOne")}</button></div>` : ""}`).join("")}
    </div>
    <div class="card">
      <div class="row"><span>${t("toMake")}</span><span>${t("countN", todo.length)}${chosen.length > todo.length ? " · " + t("toLoad", chosen.length - todo.length) : ""}</span></div>
      ${todo.length ? (known && info.remaining != null ? `<div class="row"><span>${t("estCost")}</span><span>${t("aboutCredits", fmtNum(cost))}</span></div>` : "")
        : chosen.length ? `<div class="row"><span>${t("cost")}</span><span>${t("free")}</span></div>` : ""}
      ${short ? `<div class="warn">${t("notEnough")}</div>` : ""}
    </div>
    <div class="pair">
      ${mine && job.status === "done" ? `<button class="sub" id="toggle">${t("toggleSubs")}</button>` : ""}
      <button id="go" ${!chosen.length || short ? "disabled" : ""}>${go}</button>
    </div>`;

  const light = (v, on, scroll) =>
    chrome.tabs.sendMessage(tabId, { type: "highlight", i: v.i, on, scroll }, { frameId: v.frameId }).catch(() => {});
  for (const row of main.querySelectorAll(".pick")) {
    const v = vids[+row.dataset.n];
    const box = row.querySelector("input");
    row.onmouseenter = box.onfocus = () => light(v, true);
    row.onmouseleave = box.onblur = () => light(v, false);
    box.onchange = () => {
      if (box.checked) unchecked.delete(v.src);
      else unchecked.add(v.src);
      light(v, true, true);
      renderMulti(job);
    };
    if (!v.cached) continue;
    // 만든 후: 받기(SRT·TXT), ⋯ 로 복사·다시 만들기·지우기. 버튼을 눌러도 체크는 바뀌지 않게 한다.
    const name = t("videoN", +row.dataset.n + 1);
    bindGet(row, v.src, name);
    row.querySelector("[data-more]").onclick = (e) => {
      e.preventDefault();
      opened = opened === v.src ? null : v.src;
      renderMulti(job);
    };
    const more = main.querySelector(`.morebox[data-n="${row.dataset.n}"]`);
    if (!more) continue;
    bindGet(more, v.src, name);
    more.querySelector("[data-remake]").onclick = () => chrome.runtime.sendMessage({ type: "remake", tabId, srcs: [v.src] });
    // 지우기: 실수 방지로 두 번 눌러야 지워진다(4초 안에 다시 누르기)
    const del = more.querySelector("[data-del]");
    del.onclick = async () => {
      if (!del.dataset.armed) {
        del.dataset.armed = "1";
        del.textContent = t("deleteConfirm");
        setTimeout(() => { delete del.dataset.armed; del.textContent = t("deleteOne"); }, 4000);
        return;
      }
      opened = null;
      await chrome.storage.local.remove(["cues:" + v.src, "meta:" + v.src, "sync:" + v.src]);
    };
  }
  $("checkall").onclick = () => {
    if (allOn) for (const v of vids) unchecked.add(v.src);
    else unchecked.clear();
    renderMulti(job);
  };
  $("go").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId, srcs: chosen.map((v) => v.src) });
  if ($("toggle")) $("toggle").onclick = () => chrome.tabs.sendMessage(tabId, { type: "command", name: "toggle" }).catch(() => {});
  if ($("retryfailed")) $("retryfailed").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId, srcs: failed });
  if ($("rekey")) $("rekey").onclick = () => renderKey();
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

// ---------- [보관함] 탭: 지금까지 만든 모든 자막 ----------
// 제목을 누르면 그 페이지를 열고, 이 페이지의 영상 자막에는 "이 페이지" 표시. 많아지면 제목 찾기 칸.
const titleOf = (it) => {
  if (it.meta.title) return it.meta.title;
  try { const u = new URL(it.url); return u.hostname + u.pathname; } catch { return it.url; }
};
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
  $("libsearch").hidden = items.length < 6;
  const here = new Set(info ? [info.url, ...(info.videos || []).map((v) => v.src)].filter(Boolean) : []);
  const q = libQuery.trim().toLowerCase();
  const shown = q ? items.filter((it) => titleOf(it).toLowerCase().includes(q)) : items;
  if (!shown.length) {
    $("saved").innerHTML = `<li class="empty">${items.length ? t("noMatch") : t("savedEmpty")}</li>`;
    return;
  }
  const trash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;
  $("saved").innerHTML = shown.map((it) => {
    const title = titleOf(it);
    const parts = [t("lines", it.lines), fmtTime(it.duration)];
    if (it.createdAt) parts.push(new Date(it.createdAt).toLocaleDateString(lang));
    if (it.sync) parts.push(t("syncShort", (it.sync > 0 ? "+" : "−") + Math.abs(it.sync).toFixed(1)));
    const head = it.meta.page
      ? `<button class="title open" title="${esc(t("openPage", title))}">${esc(title)}</button>`
      : `<div class="title" title="${esc(it.url)}">${esc(title)}</div>`;
    return `<li><div class="info">${head}
      <div class="meta">${here.has(it.url) ? `<b class="here">${t("thisPage")}</b> · ` : ""}${esc(parts.join(" · "))}</div></div>
      ${getButtons()}<button class="del" aria-label="${esc(t("deleteAria", title))}">${trash}</button></li>`;
  }).join("");
  $("saved").querySelectorAll("li").forEach((li, k) => {
    const it = shown[k];
    bindGet(li, it.url);
    li.querySelector(".del").onclick = () => chrome.storage.local.remove(["cues:" + it.url, "meta:" + it.url, "sync:" + it.url]);
    const open = li.querySelector(".title.open");
    if (open) open.onclick = () => chrome.tabs.create({ url: it.meta.page });
  });
}

// ---------- 자막 받기(.srt / .txt / 복사) ----------
// 영상별로 맞춘 싱크를 반영한다. 윈도우 프로그램이 한글을 알아보도록 파일에는 BOM 을 붙인다.
function srtTime(sec) {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}
const toSrt = (cues, sync) => cues.map((c, n) => `${n + 1}\n${srtTime(c.start + sync)} --> ${srtTime(c.end + sync)}\n${c.text}\n`).join("\n");
// TXT: 짧은 자막 줄을 이어 붙여 문장마다 한 줄. mode "time" 이면 문장 앞에 [분:초].
function toTxt(cues, sync, mode) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (cur) cur.text += " " + c.text;
    else cur = { start: c.start + sync, text: c.text };
    if (/[.?!。…]["'”’)\]]?$/.test(c.text.trim())) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.map((l) => (mode === "time" ? `[${fmtTime(Math.max(0, l.start))}] ` : "") + l.text.trim()).join("\n") + "\n";
}
const fileName = (title, extra) =>
  ((title || "").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "subtitles") + (extra ? " - " + extra : "");
// kind: srt | txt | copy. extra: 같은 페이지 영상끼리 파일 이름이 겹치지 않게 붙이는 말(예: 영상 2)
async function getSubs(url, kind, extra, btn) {
  const all = await chrome.storage.local.get(["cues:" + url, "meta:" + url, "sync:" + url, "txtMode"]);
  const cues = all["cues:" + url] || [], sync = all["sync:" + url] || 0, meta = all["meta:" + url] || {};
  if (kind === "copy") {
    await navigator.clipboard.writeText(toTxt(cues, sync, all.txtMode));
    if (btn) {
      btn.textContent = t("copied");
      setTimeout(() => (btn.textContent = t("copy")), 1500);
    }
    return;
  }
  const text = kind === "srt" ? toSrt(cues, sync) : toTxt(cues, sync, all.txtMode);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + text], { type: kind === "srt" ? "application/x-subrip" : "text/plain" }));
  a.download = fileName(meta.title, extra) + "." + kind;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const getButtons = (copy) =>
  `<button class="mini" data-get="srt">SRT</button><button class="mini" data-get="txt">TXT</button>${copy ? `<button class="mini" data-get="copy">${t("copy")}</button>` : ""}`;
const saveBar = () => `<div class="savebar"><span>${t("saveSubs")}</span>${getButtons(true)}</div>`;
function bindGet(root, url, extra) {
  for (const b of root.querySelectorAll("[data-get]"))
    b.onclick = (e) => {
      e.preventDefault(); // 영상 목록 줄(label) 안에서 눌러도 체크가 바뀌지 않게
      getSubs(url, b.dataset.get, extra, b);
    };
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
  renderSaved(); // 보관함의 "이 페이지" 표시
}

(async () => {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll("[data-i18n-label]")) el.setAttribute("aria-label", t(el.dataset.i18nLabel));
  $("preview").setAttribute("aria-label", t("preview"));

  $("tab-subs").onclick = () => showTab("subs");
  $("tab-lib").onclick = () => showTab("lib");
  $("tab-look").onclick = () => showTab("look");
  $("libsearch").oninput = () => {
    libQuery = $("libsearch").value;
    renderSaved();
  };
  // TXT 모양(문장별 / 시간 붙이기)
  const { txtMode } = await chrome.storage.local.get("txtMode");
  for (const r of document.querySelectorAll("input[name=txtmode]")) {
    r.checked = r.value === (txtMode || "plain");
    r.onchange = () => r.checked && chrome.storage.local.set({ txtMode: r.value });
  }
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
    // 다 만들었으면(또는 멈췄으면) 영상 목록의 "자막 있음"도 맞도록 정보를 다시 받는다
    if (info.videos && info.job && info.job.status !== "running") load();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.style) {
      style = MiriStyle.normalize(ch.style.newValue);
      renderLook();
    }
    if (Object.keys(ch).some((k) => /^(cues|meta|sync):/.test(k))) {
      renderSaved();
      // 이 페이지 영상의 자막이 생기거나 지워졌으면 자막 탭도 다시 그린다(만드는 중이 아닐 때)
      const here = info && info.hasKey ? [info.url, ...(info.videos || []).map((v) => v.src)] : [];
      const busy = info && info.job && info.job.status === "running";
      if (!busy && Object.keys(ch).some((k) => k.startsWith("cues:") && here.includes(k.slice(5)))) load();
    }
    if (ch.apiKey || ch.baseUrl) renderConn();
  });
  setInterval(() => info && info.job && info.job.status === "running" && render(), 1000);
})();
