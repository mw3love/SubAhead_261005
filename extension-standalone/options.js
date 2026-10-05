// 설정 페이지: 자막 모양(미리보기) / 단축키 목록 / 게이트웨이 키.
const $ = (id) => document.getElementById(id);
const S = MiriStyle;
let style = S.DEFAULT;

// 미리보기: 실제와 같은 방식(브라우저 기본 자막)으로 샘플 자막을 띄운다.
const pv = $("pv");
const pvTrack = pv.addTextTrack("subtitles", "미리보기", "ko");
const pvCue = new VTTCue(0, 3600, "미리 자막은 이렇게 보여요. 아무 데나 넘겨도 맞아요.");
pvTrack.addCue(pvCue);
pvTrack.mode = "showing";
const pvStyle = document.createElement("style");
document.head.appendChild(pvStyle);

const GROUPS = [
  ["size", "글자 크기", S.SIZES.map(([v, l]) => [v, l])],
  ["color", "글자색", S.COLORS.map(([v, l]) => [v, `<i class="sw" style="background:${v}"></i>${l}`])],
  ["bg", "배경", S.BGS.map(([v, l]) => [v, l])],
  ["edge", "글자 테두리", S.EDGES.map(([v, l]) => [v, l])],
  ["position", "위치", S.POSITIONS.map(([v, l]) => [v, l])],
];

function renderControls() {
  $("controls").innerHTML = GROUPS.map(([key, title, opts]) => `
    <fieldset class="field"><legend>${title}</legend><div class="seg">
      ${opts.map(([v, l]) => `<label><input type="radio" name="${key}" value="${v}"
        ${String(style[key]) === String(v) ? "checked" : ""}><span>${l}</span></label>`).join("")}
    </div></fieldset>`).join("");
  for (const input of $("controls").querySelectorAll("input")) {
    input.onchange = () => {
      const raw = input.value;
      save({ ...style, [input.name]: input.name === "bg" ? +raw : raw });
    };
  }
}

function applyPreview() {
  pvStyle.textContent = S.css(style);
  S.place(pvCue, style);
  pvTrack.mode = "hidden";
  pvTrack.mode = "showing";
}

async function save(next) {
  style = S.normalize(next);
  applyPreview();
  await chrome.storage.local.set({ style });
}

$("reset").onclick = async () => {
  await save(S.DEFAULT);
  renderControls();
};

// 단축키 바꾸기 버튼(background 의 크기 단축키) 등으로 다른 곳에서 바뀌어도 따라간다
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.style) return;
  style = S.normalize(ch.style.newValue);
  applyPreview();
  renderControls();
});

async function renderCommands() {
  const cmds = await chrome.commands.getAll();
  $("cmds").innerHTML = cmds
    .filter((c) => c.description)
    .map((c) => `<tr><td>${c.description}</td><td>${c.shortcut ? `<kbd>${c.shortcut}</kbd>` : `<span class="none">지정 안 됨</span>`}</td></tr>`)
    .join("");
}
$("shortcuts").onclick = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });

// 저장된 자막: cues:<url> 자막, meta:<url> 목록 정보, sync:<url> 맞춘 싱크
const LIMIT = 10 * 1024 * 1024; // chrome.storage.local 기본 한도
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtTime = (sec) => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = String(sec % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + r : m + ":" + r;
};
const fmtSize = (b) => (b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + " KB" : (b / 1024 / 1024).toFixed(1) + " MB");

async function renderSaved() {
  const all = await chrome.storage.local.get(null);
  const urls = Object.keys(all).filter((k) => k.startsWith("cues:")).map((k) => k.slice(5));
  const items = urls.map((url) => {
    const meta = all["meta:" + url] || {};
    const cues = all["cues:" + url] || [];
    return { url, meta, lines: meta.lines || cues.length, duration: meta.duration || (cues.length ? cues[cues.length - 1].end : 0),
             sync: all["sync:" + url] || 0, createdAt: meta.createdAt || 0 };
  }).sort((a, b) => b.createdAt - a.createdAt);

  const used = await chrome.storage.local.getBytesInUse(urls.flatMap((u) => ["cues:" + u, "meta:" + u, "sync:" + u]));
  $("savedsum").textContent = items.length
    ? `${items.length}개 · ${fmtSize(used)} 사용 중 (한도 10 MB의 ${Math.max(1, Math.round((used / LIMIT) * 100))}%)`
    : "한 번 만든 자막은 여기 저장돼서, 같은 영상을 다시 열면 크레딧 없이 바로 붙어요.";
  $("clearall").hidden = !items.length;

  if (!items.length) {
    $("saved").innerHTML = `<li class="empty">아직 저장된 자막이 없어요.</li>`;
    return;
  }
  $("saved").innerHTML = items.map((it, i) => {
    let title = it.meta.title;
    if (!title) {
      try { const u = new URL(it.url); title = u.hostname + u.pathname; } catch { title = it.url; }
    }
    const parts = [it.lines + "줄", fmtTime(it.duration)];
    if (it.createdAt) parts.push(new Date(it.createdAt).toLocaleDateString("ko-KR"));
    if (it.sync) parts.push("싱크 " + (it.sync > 0 ? "+" : "−") + Math.abs(it.sync).toFixed(1) + "초");
    return `<li><div class="info"><div class="title" title="${esc(it.url)}">${esc(title)}</div>
      <div class="meta">${esc(parts.join(" · "))}</div></div>
      <button class="sub small" data-i="${i}" aria-label="${esc(title)} 자막 지우기">지우기</button></li>`;
  }).join("");
  for (const btn of $("saved").querySelectorAll("button[data-i]")) {
    const url = items[+btn.dataset.i].url;
    btn.onclick = () => chrome.storage.local.remove(["cues:" + url, "meta:" + url, "sync:" + url]);
  }
}

// 모두 지우기: 실수 방지로 두 번 눌러야 지워진다(4초 안에 다시 누르기)
let clearArmed = null;
$("clearall").onclick = async () => {
  const btn = $("clearall");
  if (!clearArmed) {
    btn.textContent = "정말 모두 지울까요? 한 번 더 누르세요";
    clearArmed = setTimeout(() => { clearArmed = null; btn.textContent = "모두 지우기"; }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = "모두 지우기";
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => /^(cues|meta|sync):/.test(k));
  await chrome.storage.local.remove(keys);
};

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && Object.keys(ch).some((k) => /^(cues|meta|sync):/.test(k))) renderSaved();
});

async function renderKeyState() {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  $("keystate").textContent = apiKey
    ? "저장된 키: ••••" + apiKey.slice(-4) + " · 이 브라우저에만 저장돼요."
    : "아직 키가 없어요. JBNU 게이트웨이 API 키를 넣어 주세요.";
}
$("save").onclick = async () => {
  const msg = $("keymsg");
  msg.className = "";
  msg.textContent = "확인 중…";
  const r = await chrome.runtime.sendMessage({ type: "saveKey", apiKey: $("key").value.trim() });
  msg.className = r.ok ? "ok" : "err";
  msg.textContent = r.ok ? "✓ 저장했어요." : "✗ " + r.message;
  if (r.ok) $("key").value = "";
  renderKeyState();
};

(async () => {
  style = S.normalize((await chrome.storage.local.get("style")).style);
  renderControls();
  applyPreview();
  renderCommands();
  renderSaved();
  renderKeyState();
})();
