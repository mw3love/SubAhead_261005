// 영상 받기 → ffmpeg.wasm 으로 소리만 뽑기 → 게이트웨이(Soniox)에 받아 적기. 암호화된 HLS 는 지원하지 않는다.
// 진행 상황은 단계(stage)와 함께, 실패는 오류 종류(code)와 함께 background 로 보낸다.
import { FFmpeg } from "./lib/ffmpeg/index.js";

const GATEWAY = "https://factchat-cloud.mindlogic.ai/v1/gateway";
const MODEL = "stt-async-v5";
let ffmpeg;

class AppError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail || "";
  }
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: chrome.runtime.getURL("lib/core/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("lib/core/ffmpeg-core.wasm"),
  });
  return ffmpeg;
}

async function fetchMedia(url) {
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new AppError("NETWORK", e.message + ": " + url.slice(0, 80));
  }
  if (!r.ok) throw new AppError("MEDIA_BLOCKED", "영상 서버 응답 " + r.status + ": " + url.slice(0, 80));
  return r;
}

async function fetchGateway(path, opts) {
  let r;
  try {
    r = await fetch(GATEWAY + path, opts);
  } catch (e) {
    throw new AppError("NETWORK", e.message);
  }
  if (r.ok) return r.json();
  const body = (await r.text()).slice(0, 300);
  if (r.status === 401 || r.status === 403) throw new AppError("BAD_KEY", "게이트웨이 " + r.status + ": " + body);
  if (r.status === 402 || /credit|quota|insufficient|balance/i.test(body))
    throw new AppError("NO_CREDIT", "게이트웨이 " + r.status + ": " + body);
  throw new AppError("STT_FAILED", "게이트웨이 " + r.status + ": " + body);
}

async function download(url, report) {
  // 일반 파일은 그대로, HLS(m3u8)는 조각을 이어 붙인다.
  const buf = new Uint8Array(await (await fetchMedia(url)).arrayBuffer());
  const head = new TextDecoder().decode(buf.slice(0, 64)).trimStart();
  if (!head.startsWith("#EXTM3U")) return buf;

  let text = new TextDecoder().decode(buf);
  if (text.includes("#EXT-X-STREAM-INF")) {
    // 마스터 목록: 소리만 있는 트랙이 있으면 그걸, 없으면 가장 가벼운 화질.
    const audio = text.match(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="([^"]+)"/);
    if (audio) url = new URL(audio[1], url).href;
    else {
      const variants = [...text.matchAll(/#EXT-X-STREAM-INF:([^\n]*)\n([^\n#][^\n]*)/g)];
      const bw = (v) => +((v[1].match(/BANDWIDTH=(\d+)/) || [0, 0])[1]);
      url = new URL(variants.reduce((a, b) => (bw(b) < bw(a) ? b : a))[2].trim(), url).href;
    }
    text = await (await fetchMedia(url)).text();
  }
  for (const m of text.matchAll(/#EXT-X-KEY:([^\n]*)/g))
    if (!m[1].includes("METHOD=NONE")) throw new AppError("ENCRYPTED");

  const parts = [];
  const init = text.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/);
  if (init) parts.push(new URL(init[1], url).href);
  for (const l of text.split("\n")) if (l.trim() && !l.startsWith("#")) parts.push(new URL(l.trim(), url).href);

  const chunks = new Array(parts.length);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      chunks[i] = new Uint8Array(await (await fetchMedia(parts[i])).arrayBuffer());
      report("download", "영상 조각 " + ++done + "/" + parts.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function extractAudio(media, report) {
  report("extract", (media.length / 1e6).toFixed(0) + " MB");
  const ff = await getFFmpeg();
  await ff.writeFile("in", media);
  const code = await ff.exec(["-i", "in", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", "out.m4a"]);
  await ff.deleteFile("in");
  if (code !== 0) throw new AppError("FFMPEG", "ffmpeg 코드 " + code);
  const audio = await ff.readFile("out.m4a");
  await ff.deleteFile("out.m4a");
  return audio;
}

async function transcribe(audio, apiKey, report) {
  const auth = { Authorization: "Bearer " + apiKey };
  report("upload", (audio.length / 1e6).toFixed(1) + " MB");
  const form = new FormData();
  form.append("model", MODEL);
  form.append("language", "ko");
  form.append("file", new Blob([audio], { type: "audio/mp4" }), "audio.m4a");
  const r = await fetchGateway("/audio/transcriptions/", { method: "POST", headers: auth, body: form });
  if (!r.operation_id) throw new AppError("STT_FAILED", "operation_id 없음: " + JSON.stringify(r).slice(0, 200));
  const t0 = Date.now();
  while (true) {
    await new Promise((res) => setTimeout(res, 3000));
    report("transcribe", Math.round((Date.now() - t0) / 1000) + "초 경과");
    const st = await fetchGateway("/audio/transcriptions/" + r.operation_id + "/", { headers: auth });
    if (st.status === "completed") return { segments: st.segments || [], credits: r.credits_charged };
    if (st.status === "failed" || st.status === "error")
      throw new AppError("STT_FAILED", JSON.stringify(st).slice(0, 200));
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen" || msg.type !== "transcribe") return;
  const { tabId, url, apiKey } = msg;
  const report = (stage, detail) => chrome.runtime.sendMessage({ type: "progress", tabId, url, stage, detail });
  (async () => {
    try {
      report("download", "");
      const media = await download(url, report);
      const audio = await extractAudio(media, report);
      const { segments, credits } = await transcribe(audio, apiKey, report);
      chrome.runtime.sendMessage({ type: "result", tabId, url, segments, credits });
    } catch (e) {
      chrome.runtime.sendMessage({ type: "failed", tabId, url, code: e.code || "UNKNOWN", detail: e.code ? e.detail : String(e.message || e) });
    }
  })();
});
