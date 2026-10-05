// 영상 받기 → ffmpeg.wasm 으로 소리만 뽑기 → 게이트웨이(Soniox)에 받아 적기. 암호화된 HLS 는 지원하지 않는다.
// 진행 상황은 단계(stage)와 함께, 실패는 오류 종류(code)와 함께 background 로 보낸다.
// 영상 받기·소리 뽑기는 media.js 에 있다.
import { AppError, download, extractAudio } from "./media.js";

const GATEWAY = "https://factchat-cloud.mindlogic.ai/v1/gateway";
const MODEL = "stt-async-v5";

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
