// 영상 받기 → ffmpeg.wasm 으로 소리만 뽑기 → 게이트웨이(Soniox)에 받아 적기. 암호화된 HLS 는 지원하지 않는다.
// 진행 상황은 단계(stage)와 함께, 실패는 오류 종류(code)와 함께 background 로 보낸다.
// 영상 받기·소리 뽑기는 media.js 에 있다.
import { AppError, download, extractAudio, stopFFmpeg } from "./media.js";

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
  // 시간 제한: 소리 길이의 3배, 적어도 3분. 게이트웨이가 답을 주지 않으면 끝없이 기다리지 않는다.
  const limit = Math.max(180, 3 * (r.duration_seconds || 0)) * 1000;
  const until = Date.now() + limit;
  while (true) {
    await new Promise((res) => setTimeout(res, 3000));
    if (Date.now() > until) throw new AppError("TIMEOUT", "no result after " + Math.round(limit / 1000) + "s: " + r.operation_id);
    report("transcribe", "");
    const st = await fetchGateway(baseUrl, "/audio/transcriptions/" + r.operation_id + "/", { headers: auth });
    if (st.status === "completed") return { segments: st.segments || [], credits: r.credits_charged };
    if (st.status === "failed" || st.status === "error")
      throw new AppError("STT_FAILED", JSON.stringify(st).slice(0, 200));
  }
}

// 지금 하는 작업 번호(jobId). 취소되면 그 뒤의 진행·결과는 보내지 않고 다음 단계에서 멈춘다.
let current = null;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// 영상 여러 개를 두 줄로 겹쳐 처리한다.
// 앞줄(내 PC): 영상 받기·소리 뽑기를 하나씩. 뒷줄(게이트웨이): 올리기·받아 적기를 하나씩.
// 앞 영상이 받아 적히길 기다리는 동안 다음 영상의 소리를 미리 뽑아 둔다. ffmpeg 는 앞줄만 써서 늘 하나다.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "cancel") {
    if (current === msg.jobId) {
      current = null;
      stopFFmpeg();
    }
    return;
  }
  if (msg.type !== "transcribe") return;
  const { jobId, tabId, items, baseUrl, apiKey } = msg;
  current = jobId;
  const alive = () => current === jobId;
  const send = (m) => alive() && chrome.runtime.sendMessage({ jobId, tabId, ...m });
  const reporter = (index) => (stage, detail) => {
    if (!alive()) throw new AppError("CANCELLED");
    send({ type: "progress", index, stage, detail });
  };
  const failed = (index, e) => {
    if (e.code !== "CANCELLED") send({ type: "failed", index, url: items[index].url, code: e.code || "UNKNOWN", detail: e.code ? e.detail : String(e.message || e) });
  };

  const audios = [];
  let produced = 0, remoteBusy = false;
  (async () => {
    for (let i = 0; i < items.length && alive(); i++) {
      try {
        const report = reporter(i);
        report("download", "");
        // 영상 서버에 보낼 Referer 를 이 영상의 페이지로 맞춘 뒤 받는다(background 가 규칙을 바꾸고 답한다)
        await chrome.runtime.sendMessage({ type: "referer", page: items[i].page });
        const media = await download(items[i].url, report);
        audios[i] = await extractAudio(media, report);
        if (remoteBusy && i > 0) report("queued", "");
      } catch (e) {
        audios[i] = null;
        failed(i, e);
      }
      produced = i + 1;
    }
  })();
  (async () => {
    for (let i = 0; i < items.length; i++) {
      while (produced <= i) {
        if (!alive()) return;
        await sleep(200);
      }
      const audio = audios[i];
      audios[i] = undefined;
      if (!audio || !alive()) continue;
      remoteBusy = true;
      try {
        const { segments, credits } = await transcribe(audio, { baseUrl, apiKey }, reporter(i));
        send({ type: "result", index: i, url: items[i].url, frameId: items[i].frameId, segments, credits });
      } catch (e) {
        failed(i, e);
      } finally {
        remoteBusy = false;
      }
    }
  })();
});
