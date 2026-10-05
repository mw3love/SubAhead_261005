// 영상 주소를 찾아 offscreen 문서(ffmpeg.wasm)에 자막 작업을 맡기고, 결과를 자막 줄로 나눠 영상에 붙인다.
// 진행 상황은 job:<tabId> 에 저장하고, 아이콘 배지와 영상 위 알림으로도 보여 준다.
const MEDIA_RE = /\.(m3u8|mp4|m4v|webm)(\?|$)/i;
const MAX_CUE_CHARS = 40;
const CREDITS_PER_SEC = 0.1; // stt-async-v5 실측 단가(크레딧 정보를 주는 게이트웨이에서만 예상 비용으로 씀)


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

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(["media:" + tabId, "job:" + tabId, "played:" + tabId]));

// 페이지를 새로 열면 지난 영상 주소와 끝난 작업 결과를 지운다(진행 중인 작업은 둔다).
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== "loading") return;
  const job = (await chrome.storage.session.get("job:" + tabId))["job:" + tabId];
  if (job && job.status === "running") return;
  await chrome.storage.session.remove(["media:" + tabId, "job:" + tabId, "played:" + tabId]);
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
});

async function findVideos(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      // x, y: 페이지 맨 위 기준 위치(팝업 목록을 위→아래로 매길 때). 프레임 위치(frameOffset, content.js)를 모르면 null.
      const o = typeof frameOffset === "undefined" ? null : frameOffset;
      return [...document.querySelectorAll("video")].map((v, i) => {
        const r = v.getBoundingClientRect();
        return {
          i, // 프레임 안에서 몇 번째 영상인지(팝업에서 가리킬 때 쓴다)
          src: v.currentSrc,
          area: v.clientWidth * v.clientHeight,
          duration: v.duration,
          page: location.href, // 영상이 있는 프레임 주소(받을 때 Referer 로 쓴다)
          x: o ? o.x + r.left + scrollX : null,
          y: o ? o.y + r.top + scrollY : null,
        };
      });
    },
  });
  // frameId: 영상이 있는 프레임. 만든 자막을 그 프레임에만 보낼 때 쓴다.
  // 큰 영상부터. 크기가 같으면 위쪽 영상부터(기본으로 고르는 영상이 매번 같도록).
  return results
    .flatMap((r) => (r.result || []).map((v) => ({ ...v, frameId: r.frameId })))
    .sort((a, b) => b.area - a.area || (a.y ?? Infinity) - (b.y ?? Infinity) || 0);
}

// 각 프레임이 페이지 맨 위에서 얼마나 떨어져 있는지 맨 바깥 페이지부터 안쪽으로 알린다(content.js).
// 메시지가 안쪽 프레임까지 닿을 시간을 잠깐 기다린다.
async function placeFrames(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => typeof tellFrames === "function" && tellFrames(),
  });
  await new Promise((res) => setTimeout(res, 150));
}

// 팝업에서 고를 수 있는 영상: 화면에 보이고 주소(http)가 드러난 영상. blob 영상은 어느 데이터인지 짝지을 수 없어 뺀다.
function choices(videos) {
  const seen = new Set();
  return videos
    .filter((v) => v.area > 0 && /^https?:/.test(v.src) && !seen.has(v.src) && seen.add(v.src))
    .sort((a, b) => (a.y == null) - (b.y == null) || a.y - b.y || a.x - b.x); // 페이지 위→아래, 같은 줄이면 왼쪽부터(위치 모르면 뒤로)
}

async function pickSource(tabId, videos, chosen) {
  // 0순위: 팝업에서 고른 영상. 그다음: 마지막으로 재생한 영상.
  // 1순위: <video> 에 바로 걸린 http(s) 주소. 2순위: 처음 본 m3u8(대개 마스터 목록). 3순위: 마지막 mp4.
  if (chosen && videos.some((v) => v.src === chosen)) return chosen;
  const played = (await chrome.storage.session.get("played:" + tabId))["played:" + tabId];
  if (played && videos.some((v) => v.src === played)) return played;
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

// 사용자가 설정한 API 게이트웨이(주소·키). 음성인식 모델 stt-async-v5 를 제공해야 한다.
async function getServer() {
  const { baseUrl, apiKey } = await chrome.storage.local.get(["baseUrl", "apiKey"]);
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

// https 만 허용(개발용 localhost 는 http 도 허용), 끝의 / 는 뗀다
function normalizeBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  return u.href.replace(/\/+$/, "");
}

// 크레딧 정보를 주는 게이트웨이면 남은 크레딧을, 아니면 null
async function fetchCredits(server) {
  try {
    const r = await fetch(server.baseUrl + "/credits/", { headers: { Authorization: "Bearer " + server.apiKey } });
    if (!r.ok) return null;
    return (await r.json()).total.remaining;
  } catch {
    return null;
  }
}

async function info(tabId, chosen) {
  // 팝업이 열릴 때 보여 줄 것: 키 여부, 영상 길이, 예상 비용, 남은 크레딧, 저장된 자막 여부, 진행 중 작업.
  const server = await getServer();
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  const job = (await chrome.storage.session.get("job:" + tabId))["job:" + tabId] || null;
  if (!server) return { hasKey: false, job, baseUrl: baseUrl || "" };
  let videos = [];
  try {
    await placeFrames(tabId);
    videos = await findVideos(tabId);
  } catch {
    // chrome:// 같은 페이지는 스크립트를 넣을 수 없다
  }
  const url = await pickSource(tabId, videos, chosen);
  const picked = videos.find((v) => v.src === url) || videos[0];
  const live = !!picked && picked.duration === Infinity;
  const duration = picked && isFinite(picked.duration) ? picked.duration : null;
  const cached = url ? !!(await chrome.storage.local.get("cues:" + url))["cues:" + url] : false;
  const remaining = await fetchCredits(server);
  // 고를 영상이 둘 이상일 때만 목록을 준다(자막이 이미 있는지도 함께)
  let list = choices(videos);
  if (list.length > 1) {
    const saved = await chrome.storage.local.get(list.map((v) => "cues:" + v.src));
    list = list.map((v) => ({ src: v.src, frameId: v.frameId, i: v.i, duration: isFinite(v.duration) ? v.duration : null, cached: !!saved["cues:" + v.src] }));
  } else list = null;
  const played = (await chrome.storage.session.get("played:" + tabId))["played:" + tabId] || null;
  return {
    hasKey: true,
    job,
    url,
    duration,
    live,
    estimate: duration && remaining != null ? Math.max(1, Math.ceil(duration * CREDITS_PER_SEC)) : null,
    cached,
    remaining,
    baseUrl: server.baseUrl,
    videos: list,
    played,
  };
}

async function saveServer(rawUrl, apiKey) {
  // 주소 형식을 보고, 크레딧이 들지 않는 모델 목록 요청으로 키와 모델을 확인한 뒤 저장한다.
  // 키 칸이 비어 있으면 저장된 키를 그대로 쓴다(주소만 바꿀 때).
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!baseUrl) return { ok: false, message: t("urlInvalid") };
  apiKey = apiKey || (await chrome.storage.local.get("apiKey")).apiKey;
  if (!apiKey) return { ok: false, message: t("keyEmpty") };
  try {
    const r = await fetch(baseUrl + "/models/", { headers: { Authorization: "Bearer " + apiKey } });
    if (r.status === 401 || r.status === 403) return { ok: false, message: t("keyWrong") };
    if (!r.ok) return { ok: false, message: t("keyCheckFailed", r.status) };
    const ids = ((await r.json()).data || []).map((m) => m.id);
    if (!ids.includes("stt-async-v5")) return { ok: false, message: t("keyNoModel") };
  } catch {
    return { ok: false, message: t("keyOffline") };
  }
  await chrome.storage.local.set({ baseUrl, apiKey });
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
async function setReferer(page, baseUrl) {
  const addRules = [];
  if (/^https?:/.test(page || "") && baseUrl) {
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
        excludedRequestDomains: [new URL(baseUrl).hostname],
        resourceTypes: ["xmlhttprequest", "media", "other"],
      },
    });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERER_RULE], addRules });
}

// 다시 만들기: 저장된 자막을 지우고(맞춘 싱크는 남김) 처음부터 다시 받아 적는다
async function remake(tabId, chosen) {
  let videos = [];
  try {
    videos = await findVideos(tabId);
  } catch {}
  const url = await pickSource(tabId, videos, chosen);
  if (url) await chrome.storage.local.remove(["cues:" + url, "meta:" + url]);
  return start(tabId, chosen);
}

async function start(tabId, chosen) {
  const server = await getServer();
  if (!server) return fail(tabId, null, "NO_KEY");
  let videos = [];
  try {
    videos = await findVideos(tabId);
  } catch {}
  const url = await pickSource(tabId, videos, chosen);
  if (!url) return fail(tabId, null, "NO_VIDEO");
  // 고른 영상이 있는 프레임(영상 주소로 찾는다). 못 찾으면(m3u8 등) 모든 프레임에 보낸다.
  const source = videos.find((v) => v.src === url);
  if ((source || videos[0] || {}).duration === Infinity) return fail(tabId, url, "LIVE");
  const frameId = source ? source.frameId : null;
  const cacheKey = "cues:" + url;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) {
    await sendCues(tabId, url, cached, frameId);
    return setJob(tabId, { status: "done", message: t("jobLoaded"), lines: cached.length, url });
  }
  await setJob(tabId, { status: "running", stage: "download", detail: "", url, startedAt: Date.now() });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  await setReferer(((source || videos[0]) || {}).page || (tab && tab.url), server.baseUrl);
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: "offscreen", type: "transcribe", tabId, frameId, url, ...server });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "info") {
    info(msg.tabId, msg.src).then(reply);
    return true;
  }
  if (msg.type === "saveKey") {
    saveServer(msg.baseUrl, msg.apiKey).then(reply);
    return true;
  }
  if (msg.type === "start") start(msg.tabId, msg.src);
  if (msg.type === "remake") remake(msg.tabId, msg.src);
  // 영상이 여러 개일 때 기본으로 고를 영상: 마지막으로 재생한 영상
  if (msg.type === "played" && sender.tab) chrome.storage.session.set({ ["played:" + sender.tab.id]: msg.src });
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
      await sendCues(msg.tabId, msg.url, cues, msg.frameId);
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
    const size = MiriStyle.nextSize(style.size);
    await chrome.storage.local.set({ style: { ...style, size } });
    chrome.tabs.sendMessage(tab.id, { type: "notice", title: t("sizeValue", size) }).catch(() => {});
  } else {
    chrome.tabs.sendMessage(tab.id, { type: "command", name }).catch(() => {});
  }
}
chrome.commands.onCommand.addListener(onCommand);
