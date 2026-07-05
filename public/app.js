const grid = document.getElementById("grid");
const alertsList = document.getElementById("alerts");
const reportsList = document.getElementById("reports");

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

function formatDateTime(ms) {
  return new Date(ms).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startedAt, endedAt) {
  if (!endedAt) return "配信中";
  const min = Math.round((endedAt - startedAt) / 60000);
  if (min >= 60) return `${Math.floor(min / 60)}時間${min % 60}分`;
  return `${min}分`;
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

async function refreshReports() {
  try {
    const res = await fetch("/api/reports");
    const { reports } = await res.json();

    if (reports.length === 0) {
      reportsList.innerHTML = '<li class="empty">配信が終わるとここに振り返りが並びます</li>';
      return;
    }

    reportsList.innerHTML = reports
      .map(({ id, channel, title, startedAt, endedAt, sampleCount }) => `
        <li class="report-item">
          <a href="/reports/${encodeURIComponent(id)}">
            <span class="report-channel">${esc(channel)}</span>
            <span class="report-title">${esc(title) || "–"}</span>
            <span class="report-meta">${formatDateTime(startedAt)} ｜ ${formatDuration(startedAt, endedAt)} ｜ ${sampleCount}点</span>
          </a>
        </li>`)
      .join("");
  } catch (e) {
    console.error("reports fetch error:", e);
  }
}

refresh();
refreshReports();
setInterval(refresh, 5_000);
setInterval(refreshReports, 30_000);
