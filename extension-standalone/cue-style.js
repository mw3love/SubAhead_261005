// 자막 모양 설정 → video::cue CSS·자막 위치(VTTCue), 팝업 미리보기 글자 모양으로 바꾸는 공용 코드.
// content.js·popup.js·background.js 가 함께 쓴다.
globalThis.MiriStyle = (() => {
  // size: 글자 크기 0~100 — 50 이 "보통"(Chrome 기본 자막의 1.4배). 0 은 그 10%, 100 은 250%.
  // color: 흰색·노랑. bg: none(테두리 자동)·half(반투명)·dark(진하게).
  // line/pos: 자막 위치 — 팝업에는 없고 Alt+드래그로만 바꾼다. null 이면 아래 가운데(기본).
  // wheel: Alt+휠(크기)·Alt+드래그(위치) 사용
  const DEFAULT = { size: 50, color: "#ffffff", bg: "dark", line: null, pos: null, wheel: true };
  const COLORS = ["#ffffff", "#facc15"];
  const BG_ALPHA = { none: 0, half: 0.45, dark: 0.8 };
  const BASE_EM = 1.4;
  const SIZE_STEP = 5;
  const LINE_MAX = 95, LINE_STEP = 5;
  const LINE_BOTTOM = 85; // 기본(아래)에서 처음 움직일 때의 출발점(브라우저 기본 위치를 대략 %로 본 값)
  const OLD_SIZE = { s: 70, m: 100, l: 130, xl: 165 }; // 1.3.0 까지의 4단계 설정(비율 %)
  const OLD_POSITION = { bottom: null, raised: 70, top: 5 }; // 1.3.0 까지의 3칸 위치

  // 0~100 ↔ 기본 대비 비율(%): 0→10, 50→100, 100→250
  const toScale = (size) => (size <= 50 ? 10 + size * 1.8 : 100 + (size - 50) * 3);
  const fromScale = (scale) => (scale <= 100 ? (scale - 10) / 1.8 : 50 + (scale - 100) / 3);
  const clampSize = (n) => Math.min(100, Math.max(0, Math.round(n)));
  const clampLine = (n) => Math.min(LINE_MAX, Math.max(0, Math.round(n)));
  const clampPos = (n) => Math.min(100, Math.max(0, Math.round(n)));

  const normalize = (raw) => {
    raw = raw || {};
    const s = { ...DEFAULT };
    // 크기: 지금 형식(숫자) → 1.4 의 비율(scale) → 1.3.0 의 4단계(문자) 순으로 본다
    if (typeof raw.size === "number") s.size = raw.size;
    else if (raw.scale != null) s.size = fromScale(+raw.scale);
    else if (typeof raw.size === "string") s.size = fromScale(OLD_SIZE[raw.size] || 100);
    s.size = clampSize(s.size);
    s.color = COLORS.includes(raw.color) ? raw.color : DEFAULT.color;
    if (raw.bg in BG_ALPHA) s.bg = raw.bg;
    else if (typeof raw.bg === "number") s.bg = raw.bg === 0 ? "none" : raw.bg < 0.7 ? "half" : "dark";
    const line = "line" in raw ? raw.line : raw.position ? OLD_POSITION[raw.position] : null;
    s.line = line == null || line === "auto" ? null : clampLine(+line);
    s.pos = raw.pos == null || raw.pos === "auto" || +raw.pos === 50 ? null : clampPos(+raw.pos);
    s.wheel = raw.wheel !== false;
    return s;
  };

  // 영상 위 브라우저 기본 자막용 CSS. 배경이 없으면 글자가 묻히지 않게 테두리를 자동으로 넣는다.
  const css = (raw) => {
    const s = normalize(raw);
    const em = +((BASE_EM * toScale(s.size)) / 100).toFixed(3);
    const shadow = s.bg === "none" ? "-0.05em -0.05em 0 #000, 0.05em -0.05em 0 #000, -0.05em 0.05em 0 #000, 0.05em 0.05em 0 #000" : "none";
    return `video::cue{font-size:${em}em;color:${s.color};background:rgba(0,0,0,${BG_ALPHA[s.bg]});text-shadow:${shadow}}`;
  };

  // 팝업 미리보기의 글자 모양(인라인 style). basePx 는 "보통"일 때 미리보기 글자 크기.
  const preview = (raw, basePx = 13) => {
    const s = normalize(raw);
    const px = ((basePx * toScale(s.size)) / 100).toFixed(1);
    const shadow = s.bg === "none" ? "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000" : "none";
    return `font-size:${px}px;color:${s.color};background:rgba(0,0,0,${BG_ALPHA[s.bg]});text-shadow:${shadow}`;
  };

  // 자막 위치. line: null 이면 브라우저 기본(아래), 숫자면 영상 높이의 %.
  // Chrome 은 VTTCue.lineAlign·positionAlign 을 지원하지 않아(2026-10 확인) line 은 자막 "윗변" 위치다.
  // pos: 자막 가운데의 좌우 위치. 상자 폭(size)은 100 으로 두면 Chrome 이 가장자리 쪽에서 상자를 알아서 좁힌다.
  const place = (cue, raw) => {
    const { line, pos } = normalize(raw);
    cue.snapToLines = line == null;
    cue.line = line == null ? "auto" : line;
    cue.align = "center";
    cue.position = pos == null ? "auto" : pos;
  };

  // 단축키 "크기 바꾸기": 다음 빠른 크기(가장 크면 처음으로)
  const PRESETS = [30, 50, 70, 90];
  const nextSize = (size) => PRESETS.find((x) => x > size) ?? PRESETS[0];

  return { DEFAULT, COLORS, SIZE_STEP, LINE_STEP, LINE_BOTTOM, normalize, clampSize, clampLine, clampPos, css, preview, place, nextSize };
})();
