(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = "job:" + tab.id;
  const show = (job) => {
    document.getElementById("msg").textContent = job ? job.message : "";
    document.getElementById("url").textContent = job && job.url ? job.url : "";
    document.getElementById("go").disabled = !!job && job.status === "running";
  };
  show((await chrome.storage.session.get(key))[key]);
  chrome.storage.session.onChanged.addListener((ch) => ch[key] && show(ch[key].newValue));
  document.getElementById("go").onclick = () => chrome.runtime.sendMessage({ type: "start", tabId: tab.id });
})();
