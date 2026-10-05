// 영상 받기와 소리 뽑기. 큰 영상도 메모리에 통째로 올리지 않도록 받은 데이터를 Blob 으로 모으고
// (크면 브라우저가 디스크에 둔다), ffmpeg 는 WORKERFS 로 그 Blob 을 복사 없이 그 자리에서 읽는다.
// 암호화된 HLS 와 생방송(끝 표시 없는 재생목록)은 받지 않는다.
import { FFmpeg } from "./lib/ffmpeg/index.js";

export class AppError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail || "";
  }
}

let ffmpeg;
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: new URL("./lib/core/ffmpeg-core.js", import.meta.url).href,
    wasmURL: new URL("./lib/core/ffmpeg-core.wasm", import.meta.url).href,
  });
  await ffmpeg.createDir("/mnt");
  return ffmpeg;
}

async function fetchMedia(url) {
  let r;
  try {
    // 로그인이 필요한 영상을 위해 그 사이트 쿠키도 함께 보낸다
    r = await fetch(url, { credentials: "include" });
  } catch (e) {
    throw new AppError("NETWORK", e.message + ": " + url.slice(0, 80));
  }
  if (!r.ok) throw new AppError("MEDIA_BLOCKED", "영상 서버 응답 " + r.status + ": " + url.slice(0, 80));
  return r;
}

export async function download(url, report) {
  // 일반 파일은 Blob 하나로, HLS(m3u8)는 조각 Blob 들을 이어 붙인 Blob 으로 돌려준다.
  const first = await (await fetchMedia(url)).blob();
  if (!(await first.slice(0, 64).text()).trimStart().startsWith("#EXTM3U")) return first;

  let text = await first.text();
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
  // 끝 표시가 없는 재생목록은 생방송(계속 늘어남)이라 받지 않는다
  if (!text.includes("#EXT-X-ENDLIST")) throw new AppError("LIVE");

  const parts = [];
  const init = text.match(/#EXT-X-MAP:[^\n]*URI="([^"]+)"/);
  if (init) parts.push(new URL(init[1], url).href);
  for (const l of text.split("\n")) if (l.trim() && !l.startsWith("#")) parts.push(new URL(l.trim(), url).href);

  const blobs = new Array(parts.length);
  let done = 0, next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      blobs[i] = await (await fetchMedia(parts[i])).blob();
      report("download", "영상 조각 " + ++done + "/" + parts.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return new Blob(blobs);
}

export async function extractAudio(blob, report) {
  report("extract", (blob.size / 1e6).toFixed(0) + " MB");
  const ff = await getFFmpeg();
  const onProgress = ({ progress }) => {
    if (progress > 0 && progress <= 1) report("extract", Math.round(progress * 100) + "%");
  };
  ff.on("progress", onProgress);
  await ff.mount("WORKERFS", { blobs: [{ name: "media", data: blob }] }, "/mnt");
  try {
    const code = await ff.exec(["-i", "/mnt/media", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", "out.m4a"]);
    if (code !== 0) throw new AppError("FFMPEG", "ffmpeg 코드 " + code);
    const audio = await ff.readFile("out.m4a");
    await ff.deleteFile("out.m4a");
    return audio;
  } finally {
    ff.off("progress", onProgress);
    await ff.unmount("/mnt");
  }
}
