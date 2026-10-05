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

let track = null, style = MiriStyle.DEFAULT, syncOffset = 0, currentUrl = null, askedSrc = null;

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
  if (!track || !track.cues) return;
  for (const c of track.cues) MiriStyle.place(c, style);
  // 이미 그려진 자막은 위치를 바로 다시 계산하지 않을 때가 있어 한 번 껐다 켠다
  if (track.mode === "showing") {
    track.mode = "hidden";
    track.mode = "showing";
  }
}

function attachCues(cues, url, offset) {
  const video = mainVideo();
  if (!video) return;
  for (const old of video.textTracks) if (old.label === TRACK_LABEL) old.mode = "disabled";
  track = video.addTextTrack("subtitles", TRACK_LABEL, "ko");
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "cues") attachCues(msg.cues, msg.url, msg.offset);
  if (msg.type === "status") showStatus(msg.job);
  if (msg.type === "command") command(msg.name);
  if (msg.type === "notice" && track) notice(msg.title, msg.text);
});
