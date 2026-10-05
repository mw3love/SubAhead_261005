"""미리 자막 서버 — 영상 주소를 받아 전체 소리를 Soniox(JBNU 게이트웨이)로 받아 적고, 시간표가 붙은 자막을 돌려준다.

실행: python3 server.py   (127.0.0.1:8765)
  POST /jobs        {"url": "...", "referer": "..."}  -> {"id": ...}
  GET  /jobs/<id>   -> {"status", "message", "cues": [{"start","end","text"}]}

외부 라이브러리 없이 macOS 기본 python3(3.9) + curl 만 쓴다.
암호화된 HLS(EXT-X-KEY)는 지원하지 않는다.
"""
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin

PORT = 8765
GATEWAY = "https://factchat-cloud.mindlogic.ai/v1/gateway"
MODEL = "stt-async-v5"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
MAX_CUE_CHARS = 40

JOBS = {}


def load_key():
    k = os.environ.get("JBNU_GATEWAY_API_KEY")
    if k:
        return k.strip()
    with open(os.path.expanduser("~/.claude/.secrets/jbnu-gateway.key")) as f:
        return f.readline().strip()


def curl(args, timeout=600):
    r = subprocess.run(["curl", "-sSL", "-f", "-A", UA] + args, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("curl 실패: " + r.stderr.decode("utf-8", "replace").strip())
    return r.stdout


def fetch_text(url, referer):
    return curl(["-e", referer or url, url], timeout=60).decode("utf-8", "replace")


def download(url, referer, out_path, job):
    """일반 파일(mp4 등)은 그대로, HLS(m3u8)는 조각을 이어 붙여 out_path 에 저장한다."""
    head = curl(["-e", referer or url, "-r", "0-2047", url], timeout=60)
    if not head.lstrip().startswith(b"#EXTM3U"):
        job["message"] = "영상 파일 내려받는 중"
        curl(["-e", referer or url, "-o", out_path, url], timeout=3600)
        return

    text = fetch_text(url, referer)
    if "#EXT-X-STREAM-INF" in text:
        # 마스터 목록: 소리만 있는 트랙이 있으면 그걸, 없으면 가장 가벼운 화질을 고른다.
        audio = re.search(r'#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="([^"]+)"', text)
        if audio:
            url = urljoin(url, audio.group(1))
        else:
            variants = re.findall(r"#EXT-X-STREAM-INF:([^\n]*)\n([^\n#][^\n]*)", text)
            bw = lambda v: int((re.search(r"BANDWIDTH=(\d+)", v[0]) or [0, 0])[1])
            url = urljoin(url, min(variants, key=bw)[1].strip())
        text = fetch_text(url, referer)

    for m in re.finditer(r"#EXT-X-KEY:([^\n]*)", text):
        if "METHOD=NONE" not in m.group(1):
            raise RuntimeError("암호화된 스트림이라 지원하지 않습니다.")

    parts = []
    init = re.search(r'#EXT-X-MAP:[^\n]*URI="([^"]+)"', text)
    if init:
        parts.append(urljoin(url, init.group(1)))
    parts += [urljoin(url, l.strip()) for l in text.splitlines() if l.strip() and not l.startswith("#")]

    done = [0]

    def get(u):
        data = curl(["-e", referer or u, u], timeout=120)
        done[0] += 1
        job["message"] = "영상 조각 내려받는 중 %d/%d" % (done[0], len(parts))
        return data

    with ThreadPoolExecutor(8) as ex:
        chunks = list(ex.map(get, parts))
    with open(out_path, "wb") as f:
        for c in chunks:
            f.write(c)


def extract_audio(path, job):
    """화면 데이터를 버리고 소리만 가볍게 뽑는다(올리는 시간 단축). ffmpeg 가 없으면 원본 그대로."""
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return path
    job["message"] = "소리만 뽑는 중 (%.1f MB)" % (os.path.getsize(path) / 1e6)
    out = path + ".m4a"
    r = subprocess.run([ffmpeg, "-y", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000",
                        "-c:a", "aac", "-b:a", "32k", out], capture_output=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError("소리 뽑기 실패: " + r.stderr.decode("utf-8", "replace").strip()[-300:])
    return out


def transcribe(path, job):
    key = load_key()
    auth = ["-H", "Authorization: Bearer " + key]
    job["message"] = "Soniox 에 올리는 중 (%.1f MB)" % (os.path.getsize(path) / 1e6)
    r = json.loads(curl(auth + ["-F", "model=" + MODEL, "-F", "language=ko", "-F", "file=@" + path,
                                GATEWAY + "/audio/transcriptions/"], timeout=3600))
    op = r.get("operation_id")
    if not op:
        raise RuntimeError("게이트웨이 응답에 operation_id 없음: %s" % r)
    job["credits"] = r.get("credits_charged")
    start = time.time()
    while True:
        time.sleep(3)
        job["message"] = "받아 적는 중 (%d초 경과)" % (time.time() - start)
        st = json.loads(curl(auth + [GATEWAY + "/audio/transcriptions/%s/" % op], timeout=60))
        if st.get("status") == "completed":
            return st.get("segments") or []
        if st.get("status") in ("failed", "error"):
            raise RuntimeError("받아 적기 실패: %s" % st)


def split_text(text):
    """긴 덩어리를 자막 한 줄 길이로 자른다. 문장 끝에서 먼저 나누고, 긴 문장은
    필요한 줄 수만큼 고르게 나눈다(짧은 꼬리 줄 방지). 자르는 곳은 쉼표 뒤를 우선한다."""
    out = []
    for sent in re.split(r"(?<=[.?!。])\s+", text.strip()):
        n = -(-len(sent) // MAX_CUE_CHARS)
        while n > 1:
            target = len(sent) / n
            spaces = [i for i, ch in enumerate(sent) if ch == " "]
            if not spaces:
                break
            commas = [i for i in spaces if sent[i - 1] == "," and abs(i - target) <= 8]
            cut = min(commas or spaces, key=lambda i: abs(i - target))
            out.append(sent[:cut].strip())
            sent = sent[cut + 1:].strip()
            n -= 1
        if sent:
            out.append(sent)
    return out


def to_cues(segments):
    """Soniox 구간을 자막 줄로 나누고, 구간 시간을 글자 수 비율로 나눠 준다."""
    cues = []
    for seg in segments:
        s, e = seg["start_ms"] / 1000.0, seg["end_ms"] / 1000.0
        lines = split_text(seg.get("text", ""))
        total = sum(len(l) for l in lines) or 1
        t = s
        for l in lines:
            d = (e - s) * len(l) / total
            cues.append({"start": round(t, 3), "end": round(t + d, 3), "text": l})
            t += d
    return cues


def run_job(job, url, referer):
    cache_file = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest() + ".json")
    try:
        if os.path.exists(cache_file):
            with open(cache_file, encoding="utf-8") as f:
                job["cues"] = json.load(f)
            job["status"], job["message"] = "done", "저장된 자막을 불러왔습니다."
            return
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "media.mp4")
            download(url, referer, path, job)
            segments = transcribe(extract_audio(path, job), job)
        job["cues"] = to_cues(segments)
        os.makedirs(CACHE, exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump(job["cues"], f, ensure_ascii=False)
        job["status"] = "done"
        job["message"] = "자막 %d줄 완성 (%.1f 크레딧)" % (len(job["cues"]), job.get("credits") or 0)
    except Exception as ex:
        job["status"], job["message"] = "error", str(ex)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        if self.path != "/jobs":
            return self._send(404, {"error": "not found"})
        req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        url = req.get("url", "")
        if not url.startswith(("http://", "https://")):
            return self._send(400, {"error": "http(s) 영상 주소가 필요합니다."})
        jid = uuid.uuid4().hex[:12]
        JOBS[jid] = {"status": "running", "message": "시작", "cues": []}
        threading.Thread(target=run_job, args=(JOBS[jid], url, req.get("referer")), daemon=True).start()
        self._send(200, {"id": jid})

    def do_GET(self):
        m = re.match(r"^/jobs/(\w+)$", self.path)
        if not m or m.group(1) not in JOBS:
            return self._send(404, {"error": "not found"})
        self._send(200, JOBS[m.group(1)])

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    load_key()
    print("미리 자막 서버: http://127.0.0.1:%d" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
