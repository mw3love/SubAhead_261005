// 자막 모양 설정 → video::cue CSS 와 자막 위치(VTTCue.line)로 바꾸는 공용 코드. content.js 와 설정 페이지가 함께 쓴다.
globalThis.MiriStyle = (() => {
  const DEFAULT = { size: "m", color: "#ffffff", bg: 0.75, edge: "none", position: "bottom" };
  // 이름표는 _locales 문구(브라우저 언어에 따라 한국어/영어)
  const t = (key) => chrome.i18n.getMessage(key);
  const SIZES = [["s", t("sizeS"), 1.0], ["m", t("sizeM"), 1.4], ["l", t("sizeL"), 1.8], ["xl", t("sizeXL"), 2.3]];
  const COLORS = [["#ffffff", t("colorWhite")], ["#facc15", t("colorYellow")], ["#a7f3d0", t("colorMint")], ["#93c5fd", t("colorSky")]];
  const BGS = [[0, t("bgNone")], [0.5, t("bgLight")], [0.75, t("bgDark")], [1, t("bgBlack")]];
  const EDGES = [["none", t("edgeNone")], ["shadow", t("edgeShadow")], ["outline", t("edgeOutline")]];
  const POSITIONS = [["bottom", t("posBottom")], ["raised", t("posRaised")], ["top", t("posTop")]];
  const SHADOW = {
    none: "none",
    shadow: "0.06em 0.06em 0.15em rgba(0,0,0,.95)",
    outline: "-0.05em -0.05em 0 #000, 0.05em -0.05em 0 #000, -0.05em 0.05em 0 #000, 0.05em 0.05em 0 #000",
  };

  const normalize = (s) => ({ ...DEFAULT, ...(s || {}) });
  const css = (s) => {
    s = normalize(s);
    const em = (SIZES.find((x) => x[0] === s.size) || SIZES[1])[2];
    return `video::cue{font-size:${em}em;color:${s.color};background:rgba(0,0,0,${s.bg});text-shadow:${SHADOW[s.edge] || "none"}}`;
  };
  // 자막 위치(줄 단위). "아래"는 브라우저 기본, "조금 위"는 아래에서 셋째 줄, "위"는 맨 윗줄.
  // Chrome 은 VTTCue.lineAlign 을 지원하지 않아 화면 % 로 아래 끝을 맞출 수 없다(2026-10 확인).
  const place = (cue, s) => {
    cue.snapToLines = true;
    cue.line = ({ bottom: "auto", raised: -3, top: 0 })[normalize(s).position] ?? "auto";
  };
  const nextSize = (size) => SIZES[(SIZES.findIndex((x) => x[0] === size) + 1) % SIZES.length];

  return { DEFAULT, SIZES, COLORS, BGS, EDGES, POSITIONS, normalize, css, place, nextSize };
})();
