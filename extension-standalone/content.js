// 자막 줄(cues)을 받으면 가장 큰 <video> 에 브라우저 기본 자막 트랙으로 붙인다.
// 기본 트랙이라 앞뒤로 넘기거나 전체화면이어도 브라우저가 알아서 그 시간의 자막을 보여 준다.
// 자막 모양은 설정(storage.local.style)을 따르고, 설정이 바뀌면 바로 다시 적용한다.
// 작업 진행 상황(status)·단축키 결과는 영상이 있는 프레임에만 작은 알림으로 띄운다.
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));
const STAGE_LABEL = {
  download: t("stageDownload"),
  extract: t("stageExtract"),
  upload: t("stageUpload"),
  transcribe: t("stageTranscribe"),
};
const TRACK_LABEL = t("trackLabel");
const SYNC_STEP = 0.5;

let track = null, trackVideo = null, placedAt; // placedAt: 마지막으로 자막 줄에 적용한 위치(undefined = 아직)
let style = MiriStyle.normalize(), syncOffset = 0, currentUrl = null, askedSrc = null;

function mainVideo() {
  return [...document.querySelectorAll("video")]
    .filter((v) => v.clientWidth * v.clientHeight > 0)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
}

function applyStyle() {
  let el = document.getElementById("mirijamak-style");
  if (!el) {
    el = document.createElement("style");
    el.id = "mirijamak-style";
    document.documentElement.appendChild(el);
  }
  el.textContent = MiriStyle.css(style);
  // 위치가 바뀔 때만 자막 줄 위치를 다시 정한다(크기만 바뀔 때 다시 그리면 깜박인다)
  const at = style.line + "|" + style.pos;
  if (!track || !track.cues || placedAt === at) return;
  placedAt = at;
  for (const c of track.cues) MiriStyle.place(c, style);
  // 이미 그려진 자막은 위치를 바로 다시 계산하지 않을 때가 있어 한 번 껐다 켠다
  if (track.mode === "showing") {
    track.mode = "hidden";
    track.mode = "showing";
  }
}

function attachCues(cues, url, offset) {
  // 자막은 모든 프레임이 함께 받는다. 그 주소를 트는 영상에 붙이고, 없으면 가장 큰 영상에 붙인다.
  // 그 영상이 다른 주소(http)를 틀고 있으면 다른 영상의 자막이라 붙이지 않는다(blob 등은 주소를 알 수 없어 붙인다).
  const video = [...document.querySelectorAll("video")].find((v) => v.currentSrc === url) || mainVideo();
  if (!video || (/^https?:/.test(video.currentSrc) && video.currentSrc !== url)) return;
  for (const old of video.textTracks) if (old.label === TRACK_LABEL) old.mode = "disabled";
  track = video.addTextTrack("subtitles", TRACK_LABEL, "ko");
  trackVideo = video;
  placedAt = undefined;
  currentUrl = url;
  syncOffset = offset || 0;
  askedSrc = video.currentSrc;
  for (const c of cues) {
    const start = Math.max(0, c.start + syncOffset);
    track.addCue(new VTTCue(start, Math.max(start, c.end + syncOffset), c.text));
  }
  track.mode = "showing";
  applyStyle();
}

function command(name) {
  // 자막이 붙은 프레임에서만 처리한다(여러 프레임이 함께 받기 때문).
  if (!track) return;
  if (name === "toggle") {
    track.mode = track.mode === "showing" ? "hidden" : "showing";
    notice(track.mode === "showing" ? t("subsOn") : t("subsOff"));
  }
  if (name === "earlier" || name === "later") {
    const d = name === "earlier" ? -SYNC_STEP : SYNC_STEP;
    syncOffset += d;
    for (const c of [...track.cues]) {
      c.startTime = Math.max(0, c.startTime + d);
      c.endTime = Math.max(c.startTime, c.endTime + d);
    }
    const total = syncOffset === 0 ? t("syncReset") : t("syncTotal", (syncOffset > 0 ? "+" : "−") + Math.abs(syncOffset).toFixed(1));
    notice(t(d < 0 ? "syncEarlier" : "syncLater", SYNC_STEP), total);
    // 영상별로 기억해 두었다가 다음에 열 때 그대로 적용한다
    if (currentUrl) chrome.storage.local.set({ ["sync:" + currentUrl]: syncOffset });
  }
}

let toastHost, toastTimer;

function showToast(kind, title, text) {
  if (!mainVideo()) return;
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;";
    const root = toastHost.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      .t{font:13px/1.45 -apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#fff;background:#1e293b;
         border-radius:10px;padding:10px 14px;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:280px;display:flex;gap:10px;align-items:flex-start}
      .dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:none;background:#facc15}
      .t.done .dot{background:#4ade80} .t.error .dot{background:#f87171} .t.info .dot{background:#93c5fd}
      .t.running .dot{animation:p 1s ease-in-out infinite} @keyframes p{50%{opacity:.3}}
      b{display:block;font-weight:600} span{opacity:.8} span:empty{display:none}
    </style><div class="t"><i class="dot"></i><div><b></b><span></span></div></div>`;
    (document.fullscreenElement || document.documentElement).appendChild(toastHost);
  }
  // 전체화면이면 전체화면 요소 안에 있어야 보인다
  const parent = document.fullscreenElement || document.documentElement;
  if (toastHost.parentNode !== parent) parent.appendChild(toastHost);
  const root = toastHost.shadowRoot;
  root.querySelector(".t").className = "t " + kind;
  root.querySelector("b").textContent = title;
  root.querySelector("span").textContent = text || "";
  toastHost.style.display = "";
  clearTimeout(toastTimer);
  if (kind !== "running") toastTimer = setTimeout(() => (toastHost.style.display = "none"), kind === "info" ? 1800 : 5000);
}

function showStatus(job) {
  if (job.status === "running") showToast("running", t("toastTitle", STAGE_LABEL[job.stage] || t("stagePreparing")), job.detail);
  else if (job.status === "done") showToast("done", t("toastTitle", t("toastDone")), job.message);
  else showToast("error", t("toastTitle", t("toastFailed")), job.message);
}

function notice(title, text) {
  showToast("info", title, text);
}

chrome.storage.local.get("style").then((s) => {
  style = MiriStyle.normalize(s.style);
  if (track) applyStyle();
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.style) return;
  style = MiriStyle.normalize(ch.style.newValue);
  if (track) applyStyle();
});

// Alt(Mac 은 Option)+휠로 크기 조절: 자막이 붙은 영상 위 어디서든. Alt 없는 휠은 절대 가로채지 않는다.
// 재생기가 영상 위에 투명한 막을 덮어도 되도록 문서 전체에서 받는다.
const WHEEL_UNIT = 100; // 마우스 한 칸(보통 약 100)마다 한 단계(크기 5). 트랙패드의 작은 신호는 모인 만큼 센다
const WHEEL_FAST = 150; // ms. 직전 단계 뒤 이보다 빨리 이어서 굴리면 한 단계를 두 배(크기 10)로
const WHEEL_IDLE = 300; // ms. 이만큼 쉬었다 굴리거나 방향을 바꾸면 남은 양은 버리고 새로 센다
let wheelAcc = 0, wheelLast = 0, wheelEvent = 0, wheelSave = null;
function onWheel(e) {
  if (!e.altKey || !style.wheel || !track || !trackVideo) return;
  const r = trackVideo.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  // 굴린 만큼 바로 반영하고, 한 단계가 안 되는 나머지는 같은 방향으로 이어 굴릴 때만 넘긴다
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  const now = performance.now();
  if (now - wheelEvent > WHEEL_IDLE || Math.sign(delta) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelEvent = now;
  wheelAcc += delta;
  const steps = Math.trunc(wheelAcc / WHEEL_UNIT);
  if (!steps) return;
  wheelAcc -= steps * WHEEL_UNIT;
  const fast = now - wheelLast < WHEEL_FAST;
  wheelLast = now;
  // 위로 돌리면(deltaY<0) 커진다
  const size = MiriStyle.clampSize(style.size - steps * MiriStyle.SIZE_STEP * (fast ? 2 : 1));
  if (size === style.size) return;
  style = { ...style, size };
  applyStyle();
  notice(t("sizeValue", size));
  clearTimeout(wheelSave);
  wheelSave = setTimeout(() => chrome.storage.local.set({ style }), 300);
}
document.addEventListener("wheel", onWheel, { capture: true, passive: false });

// Alt(Mac 은 Option)+드래그로 자막 위치 옮기기: 영상 위에서 끌면(위아래·좌우) 따라오고, 놓으면 저장한다.
// 끄는 동안에는 사이트의 클릭(재생·멈춤)과 글자 선택이 일어나지 않게 막는다.
let drag = null, dragFrame = 0;
function overVideo(e) {
  if (!trackVideo) return false;
  const r = trackVideo.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}
function swallow(e) {
  e.preventDefault();
  e.stopImmediatePropagation();
}
function onPointerDown(e) {
  if (!e.altKey || e.button !== 0 || !style.wheel || !track || !overVideo(e)) return;
  swallow(e);
  const r = trackVideo.getBoundingClientRect();
  drag = {
    x: e.clientX, y: e.clientY, w: r.width, h: r.height,
    fromLine: style.line == null ? MiriStyle.LINE_BOTTOM : style.line,
    fromPos: style.pos == null ? 50 : style.pos,
  };
  document.documentElement.style.cursor = "move";
}
function onPointerMove(e) {
  if (!drag) return;
  swallow(e);
  // 위아래로 거의 움직이지 않았으면(옆으로만 끌 때) "아래(기본)" 위치는 그대로 둔다
  const keepAuto = style.line == null && Math.abs(e.clientY - drag.y) < 4;
  const line = keepAuto ? null : MiriStyle.clampLine(drag.fromLine + ((e.clientY - drag.y) / drag.h) * 100);
  const posNum = MiriStyle.clampPos(drag.fromPos + ((e.clientX - drag.x) / drag.w) * 100);
  const pos = posNum === 50 ? null : posNum;
  if (line === style.line && pos === style.pos) return;
  style = { ...style, line, pos };
  cancelAnimationFrame(dragFrame);
  dragFrame = requestAnimationFrame(applyStyle);
  notice(t("posNotice", "↕ " + (line == null ? t("posBottom") : line + "%") + "  ↔ " + posNum + "%"));
}
function onPointerUp(e) {
  if (!drag) return;
  swallow(e);
  drag = null;
  document.documentElement.style.cursor = "";
  chrome.storage.local.set({ style });
  // 끌기 뒤에 따라오는 클릭이 재생·멈춤을 하지 않도록 잠깐만 클릭을 삼킨다
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 300);
}
for (const [type, fn] of [["pointerdown", onPointerDown], ["pointermove", onPointerMove], ["pointerup", onPointerUp]])
  window.addEventListener(type, fn, { capture: true, passive: false });

// 영상이 준비되면(또는 다른 영상으로 바뀌면) 저장된 자막이 있는지 물어본다.
function askAuto() {
  const v = mainVideo();
  if (!v || !v.currentSrc || v.currentSrc === askedSrc) return;
  askedSrc = v.currentSrc;
  chrome.runtime.sendMessage({
    type: "autoAttach",
    video: { src: v.currentSrc, area: v.clientWidth * v.clientHeight, duration: v.duration },
  }).catch(() => {});
}
document.addEventListener("loadedmetadata", (e) => e.target instanceof HTMLVideoElement && askAuto(), true);
askAuto();

// 영상이 여러 개인 페이지에서 팝업이 기본으로 고를 수 있게, 재생한 영상의 주소를 알린다.
document.addEventListener("play", (e) => {
  const v = e.target;
  if (v instanceof HTMLVideoElement && /^https?:/.test(v.currentSrc))
    chrome.runtime.sendMessage({ type: "played", src: v.currentSrc }).catch(() => {});
}, true);

// 이 프레임이 페이지 맨 위에서 떨어진 거리. 팝업 영상 목록을 페이지 위→아래로 매길 때 background 가 읽는다.
// 맨 바깥 페이지는 0, 안쪽 프레임은 바로 바깥 프레임이 postMessage 로 알려 준다(다른 사이트 프레임도 된다).
let frameOffset = window === top ? { x: 0, y: 0 } : null;
function tellFrames() {
  if (!frameOffset) return;
  for (const f of document.querySelectorAll("iframe, frame")) {
    const r = f.getBoundingClientRect();
    if (f.contentWindow)
      f.contentWindow.postMessage({ subaheadOffset: { x: frameOffset.x + r.left + scrollX, y: frameOffset.y + r.top + scrollY } }, "*");
  }
}
window.addEventListener("message", (e) => {
  if (e.source !== parent || window === top || !e.data || !e.data.subaheadOffset) return;
  frameOffset = e.data.subaheadOffset;
  tellFrames();
});

// 팝업의 영상 목록에서 가리킨 영상에 잠깐 노란 테두리를 친다(팝업이 갑자기 닫혀도 3초 뒤 지워진다).
let lit = null, litTimer;
function highlight(i, on, scroll) {
  clearTimeout(litTimer);
  if (lit) {
    lit.video.style.outline = lit.outline;
    lit.video.style.outlineOffset = lit.offset;
    lit = null;
  }
  const v = document.querySelectorAll("video")[i];
  if (!on || !v) return;
  lit = { video: v, outline: v.style.outline, offset: v.style.outlineOffset };
  v.style.outline = "4px solid #facc15";
  v.style.outlineOffset = "-4px";
  if (scroll) v.scrollIntoView({ block: "center", behavior: "smooth" });
  litTimer = setTimeout(() => highlight(0, false), 3000);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "cues") attachCues(msg.cues, msg.url, msg.offset);
  if (msg.type === "status") showStatus(msg.job);
  if (msg.type === "command") command(msg.name);
  if (msg.type === "notice" && track) notice(msg.title, msg.text);
  if (msg.type === "highlight") highlight(msg.i, msg.on, msg.scroll);
});
