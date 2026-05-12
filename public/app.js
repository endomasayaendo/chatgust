const grid = document.getElementById("grid");
const alertsList = document.getElementById("alerts");

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cardColor(rate, baseline, threshold) {
  if (baseline < 1) return rate >= 10 ? "red" : "green";
  const ratio = rate / baseline;
  if (ratio >= threshold) return "red";
  if (ratio >= threshold * 0.66) return "yellow";
  return "green";
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

async function refresh() {
  try {
    const res = await fetch("/api/status");
    const { streams, recentAlerts, config } = await res.json();

    if (streams.length === 0) {
      grid.innerHTML = '<p class="empty">現在ライブ配信はありません</p>';
    } else {
      grid.innerHTML = streams
        .sort((a, b) => b.rate - a.rate)
        .map(({ channel, title, rate, baseline }) => {
          const color = cardColor(rate, baseline, config.spikeThreshold);
          const mult = baseline > 0 ? (rate / baseline).toFixed(1) : "–";
          return `
            <div class="card ${color}">
              <div class="card-name">${esc(channel)}</div>
              <div class="card-title">${esc(title) || "–"}</div>
              <div class="card-rate">${rate}</div>
              <div class="card-meta">件/30秒 ｜ ベースライン ${baseline.toFixed(1)} (${mult}x)</div>
            </div>`;
        })
        .join("");
    }

    if (recentAlerts.length === 0) {
      alertsList.innerHTML = '<li class="empty">アラートはまだありません</li>';
    } else {
      alertsList.innerHTML = recentAlerts
        .map(({ channel, rate, baseline, at }) => {
          const mult = baseline > 0 ? (rate / baseline).toFixed(1) : "∞";
          return `
            <li class="alert-item">
              <span class="alert-channel">${esc(channel)}</span>
              <span class="alert-info">${rate} 件/30秒 ｜ ${mult}x</span>
              <span class="alert-time">${formatTime(at)}</span>
            </li>`;
        })
        .join("");
    }
  } catch (e) {
    console.error("fetch error:", e);
  }
}

refresh();
setInterval(refresh, 5_000);
