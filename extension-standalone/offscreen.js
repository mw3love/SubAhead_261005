// 영상 받기 → ffmpeg.wasm 으로 소리만 뽑기 → 게이트웨이(Soniox)에 받아 적기. 암호화된 HLS 는 지원하지 않는다.
// 진행 상황은 단계(stage)와 함께, 실패는 오류 종류(code)와 함께 background 로 보낸다.
// 영상 받기·소리 뽑기는 media.js 에 있다.
import { AppError, download, extractAudio } from "./media.js";

const MODEL = "stt-async-v5";

// 사용자가 설정한 API 게이트웨이로 요청한다
async function fetchGateway(baseUrl, path, opts) {
  let r;
  try {
    r = await fetch(baseUrl + path, opts);
  } catch (e) {
    throw new AppError("NETWORK", e.message);
  }
  if (r.ok) return r.json();
  const body = (await r.text()).slice(0, 300);
  if (r.status === 401 || r.status === 403) throw new AppError("BAD_KEY", "gateway " + r.status + ": " + body);
  if (r.status === 402 || /credit|quota|insufficient|balance/i.test(body))
    throw new AppError("NO_CREDIT", "gateway " + r.status + ": " + body);
  throw new AppError("STT_FAILED", "gateway " + r.status + ": " + body);
}

async function transcribe(audio, { baseUrl, apiKey }, report) {
  const auth = { Authorization: "Bearer " + apiKey };
  report("upload", (audio.length / 1e6).toFixed(1) + " MB");
  const form = new FormData();
  form.append("model", MODEL);
  form.append("language", "ko");
  form.append("file", new Blob([audio], { type: "audio/mp4" }), "audio.m4a");
  const r = await fetchGateway(baseUrl, "/audio/transcriptions/", { method: "POST", headers: auth, body: form });
  if (!r.operation_id) throw new AppError("STT_FAILED", "no operation_id: " + JSON.stringify(r).slice(0, 200));
  while (true) {
    await new Promise((res) => setTimeout(res, 3000));
    report("transcribe", "");
    const st = await fetchGateway(baseUrl, "/audio/transcriptions/" + r.operation_id + "/", { headers: auth });
    if (st.status === "completed") return { segments: st.segments || [], credits: r.credits_charged };
    if (st.status === "failed" || st.status === "error")
      throw new AppError("STT_FAILED", JSON.stringify(st).slice(0, 200));
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen" || msg.type !== "transcribe") return;
  const { tabId, frameId, url, baseUrl, apiKey } = msg;
  const report = (stage, detail) => chrome.runtime.sendMessage({ type: "progress", tabId, url, stage, detail });
  (async () => {
    try {
      report("download", "");
      const media = await download(url, report);
      const audio = await extractAudio(media, report);
      const { segments, credits } = await transcribe(audio, { baseUrl, apiKey }, report);
      chrome.runtime.sendMessage({ type: "result", tabId, frameId, url, segments, credits });
    } catch (e) {
      chrome.runtime.sendMessage({ type: "failed", tabId, url, code: e.code || "UNKNOWN", detail: e.code ? e.detail : String(e.message || e) });
    }
  })();
});
