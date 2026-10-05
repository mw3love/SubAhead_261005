// 영상 주소를 찾아 offscreen 문서(ffmpeg.wasm)에 자막 작업을 맡기고, 결과를 자막 줄로 나눠 영상에 붙인다.
// 진행 상황은 job:<tabId> 에 저장하고, 아이콘 배지와 영상 위 알림으로도 보여 준다.
const GATEWAY = "https://factchat-cloud.mindlogic.ai/v1/gateway";
const MEDIA_RE = /\.(m3u8|mp4|m4v|webm)(\?|$)/i;
const MAX_CUE_CHARS = 40;
const CREDITS_PER_SEC = 0.1; // Soniox stt-async-v5 실측


// 화면에 보일 문구는 _locales 에 있다(브라우저 언어에 따라 한국어/영어).
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));

// 오류 종류별 팝업 버튼(retry: 다시 시도 / key: 키 다시 넣기). 안내 문구는 _locales 의 err<종류>.
const ERROR_ACTION = {
  NO_KEY: "key", NO_VIDEO: "retry", BAD_KEY: "key", NO_CREDIT: null, MEDIA_BLOCKED: "retry",
  ENCRYPTED: null, LIVE: null, NETWORK: "retry", FFMPEG: "retry", STT_FAILED: "retry", UNKNOWN: "retry",
};

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || !MEDIA_RE.test(d.url)) return;
    const key = "media:" + d.tabId;
    chrome.storage.session.get(key).then((s) => {
      const list = s[key] || [];
      if (list.some((m) => m.url === d.url)) return;
      list.push({ url: d.url });
      chrome.storage.session.set({ [key]: list.slice(-50) });
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(["media:" + tabId, "job:" + tabId]));

// 페이지를 새로 열면 지난 영상 주소와 끝난 작업 결과를 지운다(진행 중인 작업은 둔다).
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== "loading") return;
  const job = (await chrome.storage.session.get("job:" + tabId))["job:" + tabId];
  if (job && job.status === "running") return;
  await chrome.storage.session.remove(["media:" + tabId, "job:" + tabId]);
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
});

async function findVideos(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () =>
      [...document.querySelectorAll("video")].map((v) => ({
        src: v.currentSrc,
        area: v.clientWidth * v.clientHeight,
        duration: v.duration,
        page: location.href, // 영상이 있는 프레임 주소(받을 때 Referer 로 쓴다)
      })),
  });
  return results.flatMap((r) => r.result || []).sort((a, b) => b.area - a.area);
}

async function pickSource(tabId, videos) {
  // 1순위: <video> 에 바로 걸린 http(s) 주소. 2순위: 처음 본 m3u8(대개 마스터 목록). 3순위: 마지막 mp4.
  const direct = videos.find((v) => /^https?:/.test(v.src));
  if (direct) return direct.src;
  const list = (await chrome.storage.session.get("media:" + tabId))["media:" + tabId] || [];
  const m3u8 = list.find((m) => /\.m3u8/i.test(m.url));
  if (m3u8) return m3u8.url;
  const file = list.filter((m) => !/\.m3u8/i.test(m.url)).pop();
  return file ? file.url : null;
}

function splitText(text) {
  // 문장 끝에서 먼저 나누고, 긴 문장은 필요한 줄 수만큼 고르게 나눈다(쉼표 뒤 우선).
  const out = [];
  for (let sent of text.trim().split(/(?<=[.?!。])\s+/)) {
    let n = Math.ceil(sent.length / MAX_CUE_CHARS);
    while (n > 1) {
      const target = sent.length / n;
      const spaces = [...sent].map((ch, i) => (ch === " " ? i : -1)).filter((i) => i >= 0);
      if (!spaces.length) break;
      const commas = spaces.filter((i) => sent[i - 1] === "," && Math.abs(i - target) <= 8);
      const pool = commas.length ? commas : spaces;
      const cut = pool.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
      out.push(sent.slice(0, cut).trim());
      sent = sent.slice(cut + 1).trim();
      n--;
    }
    if (sent) out.push(sent);
  }
  return out;
}

function toCues(segments) {
  const cues = [];
  for (const seg of segments) {
    const s = seg.start_ms / 1000, e = seg.end_ms / 1000;
    const lines = splitText(seg.text || "");
    const total = lines.reduce((a, l) => a + l.length, 0) || 1;
    let t = s;
    for (const l of lines) {
      const d = ((e - s) * l.length) / total;
      cues.push({ start: +t.toFixed(3), end: +(t + d).toFixed(3), text: l });
      t += d;
    }
  }
  return cues;
}

const BADGE = { running: ["…", "#1f3a8a"], done: ["✓", "#15803d"], error: ["!", "#b91c1c"] };

async function setJob(tabId, job) {
  await chrome.storage.session.set({ ["job:" + tabId]: job });
  const [text, color] = BADGE[job.status] || ["", "#000"];
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: "status", job }).catch(() => {});
}

function fail(tabId, url, code, detail) {
  if (!(code in ERROR_ACTION)) code = "UNKNOWN";
  return setJob(tabId, { status: "error", code, message: t("err" + code), action: ERROR_ACTION[code], detail: detail || "", url });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "ffmpeg.wasm 으로 영상에서 소리만 뽑는다",
  });
}

async function fetchCredits(apiKey) {
  try {
    const r = await fetch(GATEWAY + "/credits/", { headers: { Authorization: "Bearer " + apiKey } });
    if (!r.ok) return null;
    return (await r.json()).total.remaining;
  } catch {
    return null;
  }
}

async function info(tabId) {
  // 팝업이 열릴 때 보여 줄 것: 키 여부, 영상 길이, 예상 비용, 남은 크레딧, 저장된 자막 여부, 진행 중 작업.
  const { apiKey } = await chrome.storage.local.get("apiKey");
  const job = (await chrome.storage.session.get("job:" + tabId))["job:" + tabId] || null;
  if (!apiKey) return { hasKey: false, job };
  let videos = [];
  try {
    videos = await findVideos(tabId);
  } catch {
    // chrome:// 같은 페이지는 스크립트를 넣을 수 없다
  }
  const url = await pickSource(tabId, videos);
  const live = videos.length > 0 && videos[0].duration === Infinity;
  const duration = videos.length && isFinite(videos[0].duration) ? videos[0].duration : null;
  const cached = url ? !!(await chrome.storage.local.get("cues:" + url))["cues:" + url] : false;
  return {
    hasKey: true,
    job,
    url,
    duration,
    live,
    estimate: duration ? Math.max(1, Math.ceil(duration * CREDITS_PER_SEC)) : null,
    cached,
    remaining: await fetchCredits(apiKey),
  };
}

async function saveKey(apiKey) {
  // 크레딧이 들지 않는 모델 목록 요청으로 키를 확인한 뒤 저장한다.
  try {
    const r = await fetch(GATEWAY + "/models/", { headers: { Authorization: "Bearer " + apiKey } });
    if (r.status === 401 || r.status === 403) return { ok: false, message: t("keyWrong") };
    if (!r.ok) return { ok: false, message: t("keyCheckFailed", r.status) };
    const ids = ((await r.json()).data || []).map((m) => m.id);
    if (!ids.includes("stt-async-v5")) return { ok: false, message: t("keyNoModel") };
  } catch {
    return { ok: false, message: t("keyOffline") };
  }
  await chrome.storage.local.set({ apiKey });
  return { ok: true };
}

async function sendCues(tabId, url, cues, frameId) {
  // 영상별로 맞춰 둔 싱크(sync:<url>)를 함께 보낸다.
  const offset = (await chrome.storage.local.get("sync:" + url))["sync:" + url] || 0;
  const msg = { type: "cues", cues, url, offset };
  return frameId == null ? chrome.tabs.sendMessage(tabId, msg) : chrome.tabs.sendMessage(tabId, msg, { frameId });
}

async function autoAttach(tabId, frameId, video) {
  // 영상이 열리면 저장된 자막이 있는지 보고, 있으면 그 프레임에 바로 붙인다(크레딧 없음).
  const url = await pickSource(tabId, [video]);
  if (!url) return;
  const cached = (await chrome.storage.local.get("cues:" + url))["cues:" + url];
  if (!cached) return;
  await sendCues(tabId, url, cached, frameId);
  await setJob(tabId, { status: "done", message: t("jobAttached"), lines: cached.length, url });
}

// 영상 서버가 "어느 페이지에서 왔는지"를 확인하는 경우를 위해, 확장이 영상을 받을 때
// Referer·Origin 을 영상이 있던 페이지로 맞춘다. 게이트웨이 요청에는 붙이지 않는다.
const REFERER_RULE = 1;
async function setReferer(page) {
  const addRules = [];
  if (/^https?:/.test(page || "")) {
    addRules.push({
      id: REFERER_RULE,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: page },
          { header: "origin", operation: "set", value: new URL(page).origin },
        ],
      },
      condition: {
        initiatorDomains: [chrome.runtime.id],
        excludedRequestDomains: [new URL(GATEWAY).hostname],
        resourceTypes: ["xmlhttprequest", "media", "other"],
      },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERER_RULE], addRules });
}

async function start(tabId) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) return fail(tabId, null, "NO_KEY");
  let videos = [];
  try {
    videos = await findVideos(tabId);
  } catch {}
  const url = await pickSource(tabId, videos);
  if (!url) return fail(tabId, null, "NO_VIDEO");
  if (videos.length && videos[0].duration === Infinity) return fail(tabId, url, "LIVE");
  const cacheKey = "cues:" + url;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) {
    await sendCues(tabId, url, cached);
    return setJob(tabId, { status: "done", message: t("jobLoaded"), lines: cached.length, url });
  }
  await setJob(tabId, { status: "running", stage: "download", detail: "", url, startedAt: Date.now() });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await setReferer((videos[0] && videos[0].page) || (tab && tab.url));
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: "offscreen", type: "transcribe", tabId, url, apiKey });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "info") {
    info(msg.tabId).then(reply);
    return true;
  }
  if (msg.type === "saveKey") {
    saveKey(msg.apiKey).then(reply);
    return true;
  }
  if (msg.type === "start") start(msg.tabId);
  if (msg.type === "autoAttach" && sender.tab) autoAttach(sender.tab.id, sender.frameId, msg.video);
  if (msg.type === "progress") {
    chrome.storage.session.get("job:" + msg.tabId).then((s) => {
      const prev = s["job:" + msg.tabId] || {};
      setJob(msg.tabId, { status: "running", stage: msg.stage, detail: msg.detail, url: msg.url, startedAt: prev.startedAt });
    });
  }
  if (msg.type === "failed") {
    setReferer(null);
    fail(msg.tabId, msg.url, msg.code, msg.detail);
  }
  if (msg.type === "result") {
    setReferer(null);
    (async () => {
      const cues = toCues(msg.segments);
      // 설정 페이지의 "저장된 자막" 목록에 보여 줄 정보도 함께 저장한다
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      const meta = {
        title: (tab && tab.title) || "",
        page: (tab && tab.url) || "",
        createdAt: Date.now(),
        lines: cues.length,
        duration: cues.length ? cues[cues.length - 1].end : 0,
      };
      await chrome.storage.local.set({ ["cues:" + msg.url]: cues, ["meta:" + msg.url]: meta });
      await sendCues(msg.tabId, msg.url, cues);
      await setJob(msg.tabId, {
        status: "done",
        message: t("jobMade", cues.length),
        lines: cues.length,
        credits: msg.credits,
        url: msg.url,
      });
    })();
  }
});


// 단축키: 크기는 공용 설정이라 여기서 바꾸고, 켜기·끄기와 싱크는 자막이 붙은 화면에서 처리한다.
importScripts("cue-style.js");
async function onCommand(name, tab) {
  if (!tab) return;
  if (name === "size") {
    const style = MiriStyle.normalize((await chrome.storage.local.get("style")).style);
    const [key, label] = MiriStyle.nextSize(style.size);
    await chrome.storage.local.set({ style: { ...style, size: key } });
    chrome.tabs.sendMessage(tab.id, { type: "notice", title: t("sizeNotice", label) }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.id, { type: "command", name }).catch(() => {});
  }
}
chrome.commands.onCommand.addListener(onCommand);
