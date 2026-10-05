// 자막 줄(cues)을 받으면 가장 큰 <video> 에 브라우저 기본 자막 트랙으로 붙인다.
// 기본 트랙이라 앞뒤로 넘기거나 전체화면이어도 브라우저가 알아서 그 시간의 자막을 보여 준다.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "cues") return;
  const video = [...document.querySelectorAll("video")].sort(
    (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
  )[0];
  if (!video) return;
  for (const t of video.textTracks) if (t.label === "미리 자막") t.mode = "disabled";
  const track = video.addTextTrack("subtitles", "미리 자막", "ko");
  for (const c of msg.cues) track.addCue(new VTTCue(c.start, c.end, c.text));
  track.mode = "showing";
  if (!document.getElementById("mirijamak-style")) {
    const s = document.createElement("style");
    s.id = "mirijamak-style";
    s.textContent = "video::cue{font-size:1.4em;background:rgba(0,0,0,.75);color:#fff}";
    document.documentElement.appendChild(s);
  }
});
