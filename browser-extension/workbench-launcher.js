const appUrl = "http://127.0.0.1:8788";
const versionUrl = appUrl + "/api/system/version";
const statusEl = document.getElementById("status");
const retryButton = document.getElementById("retry");
const openLink = document.getElementById("open");

let attempts = 0;
let redirected = false;

async function checkWorkbenchReady() {
  attempts += 1;
  setStatus(`正在连接本地工作台... 第 ${attempts} 次检查`);

  try {
    const response = await fetch(versionUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const payload = await response.json();
    if (!payload?.version) {
      throw new Error("missing version");
    }

    if (redirected) {
      return;
    }

    redirected = true;
    setStatus("工作台已就绪，正在打开...");
    window.location.replace(appUrl);
  } catch (_error) {
    if (attempts >= 20) {
      setStatus(
        "本地服务还没完全启动好。\n稍等几秒后点“重新检查”，或者确认工作台后端已经启动。",
        true
      );
      return;
    }

    window.setTimeout(checkWorkbenchReady, 700);
  }
}

function setStatus(text, warn) {
  statusEl.textContent = text;
  statusEl.classList.toggle("warn", Boolean(warn));
}

retryButton.addEventListener("click", () => {
  attempts = 0;
  redirected = false;
  checkWorkbenchReady();
});

openLink.href = appUrl;
checkWorkbenchReady();
