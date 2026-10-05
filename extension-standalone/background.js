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
  ENCRYPTED: null, LIVE: null, NETWORK: "retry", FFMPEG: "retry", STT_FAILED: "retry", TIMEOUT: "retry", UNKNOWN: "retry",
};
// 이 오류가 나면 남은 영상도 똑같이 실패하므로 차례 만들기를 멈춘다
const STOP_ALL = ["BAD_KEY", "NO_CREDIT"];

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

// 늦는 답은 ms 까지만 기다리고 null(실패도 null)
const within = (ms, p) => Promise.race([p.catch(() => null), new Promise((res) => setTimeout(() => res(null), ms))]);

async function findVideos(tabId, withPositions) {
  // 바쁜 페이지는 답이 늦다. 3초 넘게 기다리지 않는다(팝업·만들기가 멈추지 않게). 위치 묻기는 따로 1초씩.
  const results = (await within(3000, chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () =>
      [...document.querySelectorAll("video")].map((v, i) => ({
        i, // 프레임 안에서 몇 번째 영상인지(팝업에서 가리킬 때·위치를 물을 때 쓴다)
        src: v.currentSrc,
        area: v.clientWidth * v.clientHeight,
        duration: v.duration,
        page: location.href, // 영상이 있는 프레임 주소(받을 때 Referer 로 쓴다)
      })),
  }))) || [];
  // frameId: 영상이 있는 프레임. 만든 자막을 그 프레임에만 보낼 때 쓴다.
  const videos = results.flatMap((r) => (r.result || []).map((v) => ({ ...v, frameId: r.frameId, x: null, y: null })));
  if (withPositions) await addPositions(tabId, videos);
  // 큰 영상부터. 크기가 같으면 위쪽 영상부터(기본으로 고르는 영상이 매번 같도록).
  return videos.sort((a, b) => b.area - a.area || (a.y ?? Infinity) - (b.y ?? Infinity) || 0);
}

// 영상마다 페이지 맨 위 기준 위치(x, y)를 붙인다. 맨 바깥 페이지가 안쪽 프레임에 위치를 알리게 하고(content.js),
// 잠깐 기다린 뒤 프레임마다 메시지로 묻는다. content.js 가 없는 프레임(확장을 새로 올리기 전에 연 탭 등)은 null.
// 순서는 있으면 좋은 정보라, 답이 늦는 프레임은 1초까지만 기다린다(팝업이 멈추지 않게).
async function addPositions(tabId, videos) {
  await within(1000, chrome.tabs.sendMessage(tabId, { type: "tellFrames" }, { frameId: 0 }));
  await new Promise((res) => setTimeout(res, 150));
  const pos = {};
  await Promise.all([...new Set(videos.map((v) => v.frameId))].map(async (f) => {
    pos[f] = await within(1000, chrome.tabs.sendMessage(tabId, { type: "positions" }, { frameId: f }));
  }));
  for (const v of videos) {
    const p = pos[v.frameId] && pos[v.frameId][v.i];
    if (p) Object.assign(v, p);
  }
}

// 팝업에서 고를 수 있는 영상: 화면에 보이고 주소(http)가 드러난 영상. blob 영상은 어느 데이터인지 짝지을 수 없어 뺀다.
function choices(videos) {
  const seen = new Set();
  return videos
    .filter((v) => v.area > 0 && /^https?:/.test(v.src) && !seen.has(v.src) && seen.add(v.src))
    .sort((a, b) => (a.y == null) - (b.y == null) || a.y - b.y || a.x - b.x); // 페이지 위→아래, 같은 줄이면 왼쪽부터(위치 모르면 뒤로)
}

async function pickSource(tabId, videos) {
  // 0순위: 마지막으로 재생한 영상.
  // 1순위: <video> 에 바로 걸린 http(s) 주소. 2순위: 처음 본 m3u8(대개 마스터 목록). 3순위: 마지막 mp4.
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

async function getJob(tabId) {
  return (await chrome.storage.session.get("job:" + tabId))["job:" + tabId] || null;
}

async function setJob(tabId, job) {
  await chrome.storage.session.set({ ["job:" + tabId]: job });
  const [text, color] = BADGE[job.status] || ["", "#000"];
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  // 영상 위 알림은 지금 만드는 영상의 프레임에만(영상이 여러 개면 알림이 여러 개 뜨지 않게)
  const msg = { type: "status", job };
  (job.frameId == null ? chrome.tabs.sendMessage(tabId, msg) : chrome.tabs.sendMessage(tabId, msg, { frameId: job.frameId })).catch(() => {});
}

function fail(tabId, url, code, detail, extra) {
  if (!(code in ERROR_ACTION)) code = "UNKNOWN";
  return setJob(tabId, { status: "error", code, message: t("err" + code), action: ERROR_ACTION[code], detail: detail || "", url, ...extra });
}

// 작업(job:<tabId>)을 읽고 바꾸는 일은 탭마다 한 줄로 세운다. 진행 알림과 결과가 거의 함께 와도
// 서로의 변경을 덮어쓰지 않게 하려는 것.
const jobLocks = {};
function withJob(tabId, fn) {
  const run = (jobLocks[tabId] || Promise.resolve()).then(async () => fn(await getJob(tabId))).catch((e) => console.error(e));
  jobLocks[tabId] = run;
  return run;
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

// 영상 하나의 예상 크레딧(크레딧 정보를 주는 게이트웨이에서만)
const estimateOf = (duration, remaining) => (duration && isFinite(duration) && remaining != null ? Math.max(1, Math.ceil(duration * CREDITS_PER_SEC)) : null);

async function info(tabId) {
  // 팝업이 열릴 때 보여 줄 것: 키 여부, 영상 길이, 예상 비용, 남은 크레딧, 저장된 자막 여부, 진행 중 작업.
  const server = await getServer();
  const { baseUrl } = await chrome.storage.local.get("baseUrl");
  const job = await getJob(tabId);
  if (!server) return { hasKey: false, job, baseUrl: baseUrl || "" };
  const videos = await findVideos(tabId, true); // chrome:// 같은 페이지는 빈 목록
  const url = await pickSource(tabId, videos);
  const picked = videos.find((v) => v.src === url) || videos[0];
  const live = !!picked && picked.duration === Infinity;
  const duration = picked && isFinite(picked.duration) ? picked.duration : null;
  const cached = url ? !!(await chrome.storage.local.get("cues:" + url))["cues:" + url] : false;
  const remaining = await within(5000, fetchCredits(server)); // 게이트웨이가 답하지 않아도 팝업은 열리게
  // 고를 영상이 둘 이상일 때만 목록을 준다(페이지 순서, 자막이 이미 있는지·예상 크레딧도 함께)
  let list = choices(videos);
  if (list.length > 1) {
    const saved = await chrome.storage.local.get(list.map((v) => "cues:" + v.src));
    list = list.map((v) => ({
      src: v.src, frameId: v.frameId, i: v.i,
      duration: isFinite(v.duration) ? v.duration : null,
      estimate: estimateOf(v.duration, remaining),
      cached: !!saved["cues:" + v.src],
    }));
  } else list = null;
  const played = (await chrome.storage.session.get("played:" + tabId))["played:" + tabId] || null;
  return {
    hasKey: true,
    job,
    url,
    duration,
    live,
    estimate: estimateOf(duration, remaining),
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
  // 다른 영상을 만드는 중이면 그 작업 상태를 덮어쓰지 않는다
  await withJob(tabId, (job) => (job && job.status === "running") || setJob(tabId, { status: "done", message: t("jobAttached"), lines: cached.length, url, frameId }));
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
async function remake(tabId, srcs) {
  const items = await plan(tabId, srcs);
  await chrome.storage.local.remove(items.flatMap((it) => ["cues:" + it.url, "meta:" + it.url]));
  return start(tabId, items.map((it) => it.url));
}

// ---------- 자막 만들기 ----------
// job:<tabId> 하나가 만들 영상 목록(items, 영상마다 단계 stage)을 든다. 서비스 워커가 쉬었다 깨어나도 이어지도록 저장해 둔다.
// 실제 처리는 offscreen 이 두 줄로 겹쳐 한다(내 PC: 받기·소리 뽑기 / 게이트웨이: 올리기·받아 적기).

// 만들 영상 목록: srcs(팝업 체크·오른쪽 클릭·단축키)를 주면 그 영상들, 없으면 전처럼 하나를 고른다.
async function plan(tabId, srcs) {
  const videos = await findVideos(tabId); // 페이지가 답하지 않으면 빈 목록(프레임을 모르니 자막은 모든 프레임에 보낸다)
  const urls = srcs && srcs.length ? srcs : [await pickSource(tabId, videos)].filter(Boolean);
  return urls.map((url) => {
    const v = videos.find((x) => x.src === url);
    // 영상을 못 찾으면(m3u8 등) 프레임을 모르니 모든 프레임에 보내고, 길이·주소는 가장 큰 영상 것을 쓴다
    const like = v || (urls.length === 1 ? videos[0] : null) || {};
    return { url, frameId: v ? v.frameId : null, page: like.page || null, live: like.duration === Infinity };
  });
}

async function start(tabId, srcs) {
  const server = await getServer();
  if (!server) return fail(tabId, null, "NO_KEY");
  const items = await plan(tabId, srcs);
  if (!items.length) return fail(tabId, null, "NO_VIDEO");
  if (items.length === 1 && items[0].live) return fail(tabId, items[0].url, "LIVE");
  // 이미 만든 자막은 바로 붙이고(크레딧 없음), 나머지만 만든다. 생방송은 건너뛴다.
  const saved = await chrome.storage.local.get(items.map((it) => "cues:" + it.url));
  const todo = [];
  for (const it of items) {
    const cues = saved["cues:" + it.url];
    if (cues) await sendCues(tabId, it.url, cues, it.frameId).catch(() => {});
    else if (!it.live) todo.push(it);
  }
  const urls = items.map((it) => it.url);
  if (!todo.length) return setJob(tabId, { status: "done", message: t("jobLoaded"), url: items[0].url, urls, frameId: items[0].frameId });
  // 영상 페이지 주소를 모르면 탭 주소를 Referer 로 쓴다
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  for (const it of todo) it.page = it.page || (tab && tab.url) || null;
  const first = todo[0];
  const job = {
    id: crypto.randomUUID(), status: "running", startedAt: Date.now(), urls, total: todo.length,
    items: todo.map((it) => ({ url: it.url, frameId: it.frameId, stage: "wait", detail: "" })),
    made: 0, lines: 0, credits: 0, failed: [],
    // 영상 위 알림·배지가 따라가는 "지금" 영상(가장 최근에 진행 소식이 온 영상)
    index: 0, url: first.url, frameId: first.frameId, stage: "download", detail: "",
  };
  await withJob(tabId, () => setJob(tabId, job));
  await ensureOffscreen();
  chrome.runtime.sendMessage({
    target: "offscreen", type: "transcribe", jobId: job.id, tabId,
    items: todo.map(({ url, frameId, page }) => ({ url, frameId, page })), ...server,
  });
}

// 영상 하나가 끝나면 그 영상 위에 결과 알림을 띄우고(진행 알림이 남아 있지 않게), 모두 끝났으면 결과를 정리한다.
function itemStatus(tabId, item, job) {
  chrome.tabs.sendMessage(tabId, { type: "status", job }, item.frameId == null ? undefined : { frameId: item.frameId }).catch(() => {});
}
async function finishIfDone(tabId, job) {
  const open = (it) => it.stage !== "done" && it.stage !== "failed";
  if (job.items.some(open)) {
    // 끝난 영상이 "지금" 영상이면 아직 진행 중인 영상으로 옮긴다(끝난 영상 위에 진행 알림이 다시 뜨지 않게)
    if (!open(job.items[job.index])) {
      const k = job.items.findIndex((it) => open(it) && it.stage !== "wait");
      const index = k >= 0 ? k : job.items.findIndex(open);
      const it = job.items[index];
      Object.assign(job, { index, url: it.url, frameId: it.frameId, stage: it.stage === "wait" ? "download" : it.stage, detail: it.detail });
    }
    return setJob(tabId, job);
  }
  setReferer(null);
  const summary = { urls: job.urls, total: job.total, failed: job.failed, frameId: job.frameId };
  const nFail = job.failed.length;
  if (nFail === job.total) {
    const f = job.failed[nFail - 1];
    return fail(tabId, f.url, f.code, f.detail, summary);
  }
  let message = job.total > 1 ? t("jobMadeMany", job.made) : t("jobMade", job.lines);
  if (nFail) message += " " + t("jobSomeFailed", nFail);
  return setJob(tabId, { status: "done", message, lines: job.lines, credits: job.credits, url: job.url, ...summary });
}

// 진행 중인 작업 취소. 이미 게이트웨이에 보낸 소리의 크레딧은 돌아오지 않는다.
function cancel(tabId) {
  return withJob(tabId, async (job) => {
    if (!job || job.status !== "running") return;
    chrome.runtime.sendMessage({ target: "offscreen", type: "cancel", jobId: job.id }).catch(() => {});
    setReferer(null);
    await setJob(tabId, { status: "cancelled", url: job.url, urls: job.urls, made: job.made, frameId: job.frameId });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "info") {
    info(msg.tabId).then(reply);
    return true;
  }
  if (msg.type === "saveKey") {
    saveServer(msg.baseUrl, msg.apiKey).then(reply);
    return true;
  }
  if (msg.type === "start") start(msg.tabId, msg.srcs);
  if (msg.type === "remake") remake(msg.tabId, msg.srcs);
  if (msg.type === "cancel") cancel(msg.tabId);
  // 영상이 여러 개일 때 목록에 "방금 재생"으로 표시할 영상
  if (msg.type === "played" && sender.tab) chrome.storage.session.set({ ["played:" + sender.tab.id]: msg.src });
  if (msg.type === "autoAttach" && sender.tab) autoAttach(sender.tab.id, sender.frameId, msg.video);
  // offscreen 이 영상을 받기 직전에 묻는다: Referer 규칙을 그 영상의 페이지로 바꾼 뒤 답한다
  if (msg.type === "referer") {
    getServer().then((server) => setReferer(msg.page, server && server.baseUrl)).then(() => reply(true), () => reply(false));
    return true;
  }
  // offscreen 에서 오는 진행·실패·결과(영상 번호 index). 취소됐거나 지난 작업(jobId 가 다름)의 것은 버린다.
  const mine = (job) => job && job.id === msg.jobId && job.status === "running" && job.items && job.items[msg.index];
  if (msg.type === "progress")
    withJob(msg.tabId, (job) => {
      if (!mine(job)) return;
      const item = job.items[msg.index];
      Object.assign(item, { stage: msg.stage, detail: msg.detail });
      Object.assign(job, { index: msg.index, url: item.url, frameId: item.frameId, stage: msg.stage, detail: msg.detail });
      return setJob(msg.tabId, job);
    });
  if (msg.type === "failed")
    withJob(msg.tabId, async (job) => {
      if (!mine(job)) return;
      if (STOP_ALL.includes(msg.code)) {
        // 남은 영상도 똑같이 실패하므로 모두 멈춘다
        chrome.runtime.sendMessage({ target: "offscreen", type: "cancel", jobId: job.id }).catch(() => {});
        setReferer(null);
        return fail(msg.tabId, msg.url, msg.code, msg.detail, { urls: job.urls, frameId: job.frameId });
      }
      const item = job.items[msg.index];
      item.stage = "failed";
      job.failed.push({ url: msg.url, code: msg.code, detail: msg.detail });
      if (job.total > 1) itemStatus(msg.tabId, item, { status: "error", message: t("err" + (msg.code in ERROR_ACTION ? msg.code : "UNKNOWN")) });
      return finishIfDone(msg.tabId, job);
    });
  if (msg.type === "result")
    withJob(msg.tabId, async (job) => {
      if (!mine(job)) return;
      const cues = toCues(msg.segments);
      // 설정 탭의 "저장된 자막" 목록에 보여 줄 정보도 함께 저장한다
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      const meta = {
        title: (tab && tab.title) || "",
        page: (tab && tab.url) || "",
        createdAt: Date.now(),
        lines: cues.length,
        duration: cues.length ? cues[cues.length - 1].end : 0,
      };
      await chrome.storage.local.set({ ["cues:" + msg.url]: cues, ["meta:" + msg.url]: meta });
      await sendCues(msg.tabId, msg.url, cues, msg.frameId).catch(() => {});
      const item = job.items[msg.index];
      item.stage = "done";
      job.made++;
      job.lines += cues.length;
      job.credits += msg.credits || 0;
      if (job.total > 1) itemStatus(msg.tabId, item, { status: "done", message: t("jobMade", cues.length) });
      return finishIfDone(msg.tabId, job);
    });
});

// 영상 위 오른쪽 클릭 메뉴 "이 영상 자막 만들기": 그 영상 하나만 만든다
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: "make", title: t("ctxMake"), contexts: ["video"] }));
});
async function onMenu(info, tab) {
  if (info.menuItemId !== "make" || !tab) return;
  const job = await getJob(tab.id);
  if (job && job.status === "running") return tellFrame(tab.id, job.frameId, t("alreadyMaking"));
  start(tab.id, /^https?:/.test(info.srcUrl || "") ? [info.srcUrl] : undefined);
}
chrome.contextMenus.onClicked.addListener(onMenu);

// 영상이 있는 프레임에 짧은 안내를 띄운다
function tellFrame(tabId, frameId, title, text) {
  const msg = { type: "confirm", title: t("toastTitle", title), text: text || "" };
  return (frameId == null ? chrome.tabs.sendMessage(tabId, msg) : chrome.tabs.sendMessage(tabId, msg, { frameId })).catch(() => {});
}

// 단축키로 자막 만들기: 팝업의 기본값과 같이 자막이 없는 영상을 모두 만든다.
// 팝업을 거치지 않아 비용을 볼 곳이 없으니, 한 번 누르면 비용을 알리고 4초 안에 한 번 더 누르면 시작한다.
const CONFIRM_MS = 4000;
async function makeByShortcut(tabId) {
  if (!(await getServer())) return fail(tabId, null, "NO_KEY");
  const job = await getJob(tabId);
  if (job && job.status === "running") return tellFrame(tabId, job.frameId, t("alreadyMaking"));
  const videos = await findVideos(tabId, true);
  const list = choices(videos);
  const srcs = list.length > 1 ? list.map((v) => v.src) : [await pickSource(tabId, videos)].filter(Boolean);
  if (!srcs.length) return fail(tabId, null, "NO_VIDEO");
  const saved = await chrome.storage.local.get(srcs.map((u) => "cues:" + u));
  const todo = srcs.filter((u) => !saved["cues:" + u]);
  if (!todo.length) return start(tabId, srcs); // 모두 자막이 있으면 바로 붙인다(크레딧 없음)
  const key = "confirm:" + tabId;
  const asked = (await chrome.storage.session.get(key))[key];
  if (asked && Date.now() - asked < CONFIRM_MS) {
    await chrome.storage.session.remove(key);
    return start(tabId, srcs);
  }
  await chrome.storage.session.set({ [key]: Date.now() });
  const first = videos.find((v) => v.src === todo[0]);
  const cost = todo.reduce((sum, u) => {
    const v = videos.find((x) => x.src === u);
    return sum + (v && isFinite(v.duration) ? Math.max(1, Math.ceil(v.duration * CREDITS_PER_SEC)) : 0);
  }, 0);
  tellFrame(tabId, first ? first.frameId : null, t("confirmTitle"), t("confirmText", todo.length, cost));
}

// 단축키: 크기는 공용 설정이라 여기서 바꾸고, 켜기·끄기와 싱크는 자막이 붙은 화면에서 처리한다.
importScripts("cue-style.js");
async function onCommand(name, tab) {
  if (!tab) return;
  if (name === "make") return makeByShortcut(tab.id);
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
