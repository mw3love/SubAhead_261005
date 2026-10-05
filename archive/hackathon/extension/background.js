// 탭마다 재생 중에 오간 영상 주소(m3u8 / mp4)를 기억해 두고, 팝업 요청이 오면 서버에 자막을 맡긴다.
const SERVER = "http://127.0.0.1:8765";
const MEDIA_RE = /\.(m3u8|mp4|m4v|webm)(\?|$)/i;

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || !MEDIA_RE.test(d.url)) return;
    const key = "media:" + d.tabId;
    chrome.storage.session.get(key).then((s) => {
      const list = s[key] || [];
      if (list.some((m) => m.url === d.url)) return;
      list.push({ url: d.url, referer: d.initiator ? d.initiator + "/" : "" });
      chrome.storage.session.set({ [key]: list.slice(-50) });
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(["media:" + tabId, "job:" + tabId]));

async function pickSource(tabId) {
  // 1순위: <video> 에 바로 걸린 http(s) 주소. 2순위: 처음 본 m3u8(대개 마스터 목록). 3순위: 마지막 mp4.
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () =>
      [...document.querySelectorAll("video")].map((v) => ({
        src: v.currentSrc,
        area: v.clientWidth * v.clientHeight,
        page: location.href,
      })),
  });
  const videos = results.flatMap((r) => r.result || []).sort((a, b) => b.area - a.area);
  const direct = videos.find((v) => /^https?:/.test(v.src));
  if (direct) return { url: direct.src, referer: direct.page };
  const list = (await chrome.storage.session.get("media:" + tabId))["media:" + tabId] || [];
  const referer = videos[0] ? videos[0].page : "";
  const m3u8 = list.find((m) => /\.m3u8/i.test(m.url));
  if (m3u8) return { url: m3u8.url, referer: referer || m3u8.referer };
  const file = list.filter((m) => !/\.m3u8/i.test(m.url)).pop();
  if (file) return { url: file.url, referer: referer || file.referer };
  return null;
}

async function setJob(tabId, job) {
  await chrome.storage.session.set({ ["job:" + tabId]: job });
}

async function start(tabId) {
  const src = await pickSource(tabId);
  if (!src) return setJob(tabId, { status: "error", message: "영상 주소를 못 찾았어요. 영상을 잠깐 재생한 뒤 다시 눌러 주세요." });
  await setJob(tabId, { status: "running", message: "서버에 요청 중", url: src.url });
  let id;
  try {
    const r = await fetch(SERVER + "/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(src),
    });
    id = (await r.json()).id;
  } catch (e) {
    return setJob(tabId, { status: "error", message: "자막 서버가 꺼져 있어요. 터미널에서 python3 server.py 를 실행해 주세요." });
  }
  while (true) {
    await new Promise((res) => setTimeout(res, 2000));
    const job = await (await fetch(SERVER + "/jobs/" + id)).json();
    if (job.status === "done") {
      await chrome.tabs.sendMessage(tabId, { type: "cues", cues: job.cues });
      return setJob(tabId, { status: "done", message: job.message, url: src.url });
    }
    if (job.status === "error") return setJob(tabId, { status: "error", message: job.message, url: src.url });
    await setJob(tabId, { status: "running", message: job.message, url: src.url });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "start") start(msg.tabId);
});
