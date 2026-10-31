// Shared by the English and Persian pages.
const fa = document.documentElement.lang === "fa";
const t = fa ? {
  download: "دانلود", version: "نسخه‌ی", license: "مجوز MIT", kb: "کیلوبایت",
  copy: "کپی", copied: "کپی شد", copyFail: "انتخاب و کپی کنید",
} : {
  download: "Download", version: "Version", license: "MIT license", kb: "KB",
  copy: "Copy", copied: "Copied", copyFail: "Select & copy",
};

// Point the download button at the newest release zip.
(async () => {
  try {
    const res = await fetch("https://api.github.com/repos/HAstaShakiba/rozan/releases/latest");
    if (!res.ok) return;
    const release = await res.json();
    const asset = (release.assets || []).find(a => a.name.endsWith(".zip"));
    if (!asset) return;
    const version = release.tag_name.replace(/^v/, "");
    const button = document.getElementById("download");
    button.href = asset.browser_download_url;
    button.textContent = `⬇ ${t.download} ${version}`;
    document.getElementById("release-meta").textContent =
      `${t.version} ${version} · ${Math.max(1, Math.round(asset.size / 1024))} ${t.kb} · GNOME Shell 42 · ${t.license}`;
  } catch (e) { /* keep the link to the releases page */ }
})();

// Workspace tabs.
const tabs = [...document.querySelectorAll('[role="tab"]')];
function select(tab) {
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute("aria-selected", String(on));
    other.tabIndex = on ? 0 : -1;
    document.getElementById(other.getAttribute("aria-controls")).hidden = !on;
  }
}
tabs.forEach((tab, i) => {
  tab.tabIndex = i === 0 ? 0 : -1;
  tab.addEventListener("click", () => select(tab));
  tab.addEventListener("keydown", e => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const dir = getComputedStyle(tab).direction === "rtl" ? -step : step;
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    select(next);
    next.focus();
  });
});

// Copy buttons on code blocks.
for (const pre of document.querySelectorAll("pre")) {
  const button = document.createElement("button");
  button.className = "copy";
  button.textContent = t.copy;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector("code").innerText.trim());
      button.textContent = t.copied;
      setTimeout(() => (button.textContent = t.copy), 1500);
    } catch (e) { button.textContent = t.copyFail; }
  });
  pre.appendChild(button);
}
