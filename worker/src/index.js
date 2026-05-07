// Secrets are loaded from Cloudflare Worker secrets via the `env` object.
// Set them with: wrangler secret put CAPTCHA_SECRET_KEY (and TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
let CAPTCHA_SECRET_KEY = "";
let TELEGRAM_BOT_TOKEN = "";
let TELEGRAM_CHAT_ID = "";

// --- Sync events from Telegram (Devvit → Worker) ---
async function syncEventsFromTelegram(env) {
  try {
    // Get last processed offset
    const offsetRow = await env.DB.prepare("SELECT value FROM kv_state WHERE key = 'tg_events_offset'").first();
    const offset = offsetRow ? parseInt(offsetRow.value) : 0;

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0${offset ? `&offset=${offset}` : ""}`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.ok || !data.result.length) return;

    let maxId = offset;
    for (const update of data.result) {
      maxId = Math.max(maxId, update.update_id + 1);
      const text = update.channel_post?.text || "";
      if (!text.startsWith("EVT:")) continue;

      const [, body] = text.split("EVT:");
      const parts = body.split("|");
      const evtType = parts[0];

      if (evtType === "link" && parts.length >= 6) {
        const [, sub, username, domain, sourceType, sourceId, postId] = parts;
        await env.DB.prepare(
          "INSERT INTO link_promotions (subreddit, username, domain, source_type, source_id, post_id, detected_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
        ).bind(sub, username, domain, sourceType, sourceId, postId || null).run();
      } else if (evtType === "ban" && parts.length >= 5) {
        const [, sub, username, reason, duration] = parts;
        await env.DB.prepare(
          "INSERT INTO ban_events (subreddit, username, action, reason, duration, banned_at) VALUES (?, ?, 'ban', ?, ?, datetime('now'))"
        ).bind(sub, username, reason, parseInt(duration) || 0).run();
      } else if (evtType === "unban" && parts.length >= 3) {
        const [, sub, username] = parts;
        await env.DB.prepare(
          "INSERT INTO ban_events (subreddit, username, action, reason, duration, banned_at) VALUES (?, ?, 'unban', '', 0, datetime('now'))"
        ).bind(sub, username).run();
      }
    }

    // Save offset
    await env.DB.prepare("INSERT OR REPLACE INTO kv_state (key, value) VALUES ('tg_events_offset', ?)").bind(String(maxId)).run();
  } catch (e) {
    console.error("syncEvents error:", e);
  }
}

// --- IP reputation via ip-api.com (cached) ---
async function getIpReputation(env, ip) {
  if (!ip || ip === "unknown") return null;
  // Check cache
  const cached = await env.DB.prepare("SELECT is_proxy, country, isp FROM ip_reputation WHERE ip = ? AND checked_at > datetime('now', '-30 days')").bind(ip).first();
  if (cached) return cached;

  try {
    // ip-api.com only supports http, but we can use https via a paid service or just http here
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=proxy,country,isp,status`);
    if (!resp.ok) return null;
    const d = await resp.json();
    if (d.status !== "success") return null;
    const isProxy = d.proxy ? 1 : 0;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO ip_reputation (ip, is_proxy, country, isp, checked_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).bind(ip, isProxy, d.country || "", d.isp || "").run();
    return { is_proxy: isProxy, country: d.country || "", isp: d.isp || "" };
  } catch {
    return null;
  }
}

// Derive a per-sub dashboard key from shared secret + subreddit name + timestamp
async function deriveDashboardKey(subreddit, timestamp) {
  const data = new TextEncoder().encode(CAPTCHA_SECRET_KEY + ":" + subreddit + ":" + timestamp);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

const KEY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function validateDashboardKey(subreddit, key, timestamp) {
  if (!subreddit || !key || !timestamp) return false;
  const ts = parseInt(timestamp);
  if (isNaN(ts)) return false;
  // Check expiry
  if (Date.now() - ts > KEY_MAX_AGE_MS) return false;
  // Check signature
  const expected = await deriveDashboardKey(subreddit, ts);
  return key === expected;
}

function simpleDecode(token, secretKey) {
  try {
    let padded = token.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    const encoded = atob(padded);
    const keyBytes = secretKey.split("").map((c) => c.charCodeAt(0));
    let decoded = "";
    for (let i = 0; i < encoded.length; i++) {
      decoded += String.fromCharCode(
        encoded.charCodeAt(i) ^ keyBytes[i % keyBytes.length]
      );
    }
    const parts = decoded.split("|");
    if (parts.length < 3) return null;
    return {
      code: parts[0],
      username: parts[1],
      timestamp: parseInt(parts[2]),
      subreddit: parts[3] || "unknown",
    };
  } catch {
    return null;
  }
}

function generateCaptchaSVG(code) {
  const width = 280, height = 100;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect width="100%" height="100%" fill="#f9fafb"/>`;
  for (let i = 0; i < 8; i++) {
    const x1 = Math.random()*width, y1 = Math.random()*height, x2 = Math.random()*width, y2 = Math.random()*height;
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgb(${120+Math.floor(Math.random()*80)},${120+Math.floor(Math.random()*80)},${120+Math.floor(Math.random()*80)})" stroke-width="1.5"/>`;
  }
  for (let i = 0; i < 60; i++) {
    svg += `<circle cx="${Math.random()*width}" cy="${Math.random()*height}" r="${1+Math.random()*2}" fill="rgb(${100+Math.floor(Math.random()*100)},${100+Math.floor(Math.random()*100)},${100+Math.floor(Math.random()*100)})"/>`;
  }
  const spacing = width / (code.length + 2);
  for (let i = 0; i < code.length; i++) {
    const x = spacing*(i+1)+(Math.random()*10-5), y = 55+(Math.random()*20-10), rot = Math.random()*30-15;
    svg += `<text x="${x}" y="${y}" font-family="monospace" font-size="${32+Math.floor(Math.random()*10)}" font-weight="bold" fill="rgb(${Math.floor(Math.random()*80)},${Math.floor(Math.random()*80)},${Math.floor(Math.random()*80)})" transform="rotate(${rot},${x},${y})">${code[i]}</text>`;
  }
  for (let i = 0; i < 4; i++) {
    svg += `<line x1="${Math.random()*width}" y1="${Math.random()*height}" x2="${Math.random()*width}" y2="${Math.random()*height}" stroke="rgb(${80+Math.floor(Math.random()*100)},${80+Math.floor(Math.random()*100)},${80+Math.floor(Math.random()*100)})" stroke-width="1"/>`;
  }
  for (let i = 0; i < 3; i++) {
    svg += `<path d="M${Math.random()*width},${Math.random()*height} Q${Math.random()*width},${Math.random()*height} ${Math.random()*width},${Math.random()*height}" fill="none" stroke="rgb(${100+Math.floor(Math.random()*80)},${100+Math.floor(Math.random()*80)},${100+Math.floor(Math.random()*80)})" stroke-width="1.5"/>`;
  }
  svg += `</svg>`;
  return svg;
}

function renderCaptchaPage(svgBase64) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan Slop - Verification</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6f7;color:#1a1a1a;min-height:100vh;display:flex;flex-direction:column}.header{height:58px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;padding:0 24px}.header-logo{font-size:15px;font-weight:600}.header-logo span{color:#0051c3}.main{flex:1;display:flex;align-items:center;justify-content:center;padding:40px 16px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px;max-width:460px;width:100%}.status{display:flex;align-items:flex-start;gap:12px;margin-bottom:24px;padding:16px;background:#f0f9ff;border-radius:8px}.status-icon{width:20px;height:20px;flex-shrink:0}.status-icon svg{fill:#0051c3}.status-text{font-size:14px;line-height:1.5;color:#404040}.status-text strong{color:#1a1a1a}h1{font-size:20px;font-weight:600;margin-bottom:8px}.subtitle{font-size:14px;color:#6b7280;margin-bottom:24px;line-height:1.5}.captcha-container{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;display:flex;justify-content:center;margin-bottom:24px}.captcha-container img{border-radius:6px;display:block}#hold-btn{position:relative;width:280px;height:100px;border:2px solid #0051c3;background:#fff;border-radius:8px;cursor:pointer;overflow:hidden;user-select:none;-webkit-user-select:none;transition:border-color 0.15s}#hold-btn:hover{border-color:#003d94}#hold-btn .hold-text{position:relative;z-index:2;font-size:15px;font-weight:600;color:#0051c3;display:flex;align-items:center;justify-content:center;height:100%}#hold-btn .hold-progress{position:absolute;top:0;left:0;height:100%;width:0%;background:#e0edff;transition:width 0.05s linear;z-index:1}.instructions{border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px}.instructions h3{font-size:13px;font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em}.instructions ol{margin:0;padding-left:20px}.instructions li{font-size:14px;color:#404040;line-height:1.6;padding:2px 0}.footer{background:#fff;border-top:1px solid #e5e7eb;padding:12px 24px;text-align:center}.footer-text{font-size:12px;color:#9ca3af}@media(max-width:480px){.card{padding:24px}}</style>
</head><body>
<div class="header"><div class="header-logo"><span>Scan Slop</span> / Verification</div></div>
<div class="main"><div class="card">
<div class="status"><div class="status-icon"><svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M12.603 1.5H3.398l-.5.5v4.22c0 5.388 4.367 7.933 4.865 8.207h.487c.5-.274 4.86-2.82 4.86-8.207V2l-.507-.5zM3.898 6.22V2.5H7.5v10.57c-1.25-.915-3.602-3.12-3.602-6.85zm8.205 0c0 3.73-2.34 5.935-3.6 6.85V2.5h3.6v3.72z"/></svg></div>
<div class="status-text"><strong>Human verification required.</strong> This subreddit uses Scan Slop to prevent spam and bot activity.</div></div>
<h1>Your verification code</h1><p class="subtitle">Press and hold the button below for 2 seconds to reveal your code.</p>
<div class="captcha-container" id="captcha-wrapper">
<button id="hold-btn" type="button">
  <span class="hold-text">Hold to reveal code</span>
  <div class="hold-progress"></div>
</button>
<img id="captcha-img" src="data:image/svg+xml;base64,${svgBase64}" alt="verification code" width="280" height="100" style="display:none">
</div>
<div class="instructions"><h3>How to verify</h3><ol><li>Press and hold the button above for 2 seconds</li><li>Read the 6-character code from the image</li><li>Reply to the Reddit comment with just the code</li></ol></div>
</div></div>
<script>
(function(){
  const btn = document.getElementById('hold-btn');
  const progress = btn.querySelector('.hold-progress');
  const text = btn.querySelector('.hold-text');
  const img = document.getElementById('captcha-img');
  const HOLD_TIME = 2000;
  let startTime = 0;
  let rafId = null;
  let trusted = false;

  function reveal() {
    btn.style.display = 'none';
    img.style.display = 'block';
    // Log trusted interaction to analytics
    fetch('/api/interaction?trusted=' + (trusted ? '1' : '0'), { method: 'POST' }).catch(()=>{});
  }

  function update() {
    const elapsed = Date.now() - startTime;
    const pct = Math.min(elapsed / HOLD_TIME, 1) * 100;
    progress.style.width = pct + '%';
    if (elapsed >= HOLD_TIME) {
      reveal();
      return;
    }
    rafId = requestAnimationFrame(update);
  }

  function start(e) {
    if (e.isTrusted === false) return; // synthetic event
    trusted = true;
    startTime = Date.now();
    text.textContent = 'Keep holding...';
    update();
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    progress.style.width = '0%';
    text.textContent = 'Hold to reveal code';
  }

  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', stop);
  btn.addEventListener('touchstart', start, { passive: true });
  btn.addEventListener('touchend', stop);
})();
</script>
<div class="footer"><div class="footer-text">Tired of bots in your favorite subreddit? <a href="/reddit-add-scanslop" style="color:#0051c3;text-decoration:none">Recommend Scan Slop to your mods →</a></div></div>
</body></html>`;
}

function renderDashboard(sub, data) {
  const qs = `sub=${sub}&key=${data.key}&t=${data.t}`;
  const rows = (data.visits||[]).map(v=>`<tr><td><a href="/dashboard/user?${qs}&username=${v.username}">${v.username}</a></td><td>${v.country}</td><td>${v.city||''}</td><td>${v.asn_org||''}</td><td>${v.is_bot?'Yes':'No'}</td><td>${v.visited_at}</td></tr>`).join("");
  const suspRows = (data.suspicious||[]).map(s=>`<tr><td><a href="/dashboard/user?${qs}&username=${s.username}">${s.username}</a></td><td>${s.visit_count}</td><td>${s.unique_ips}</td><td>${s.countries}</td></tr>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan Slop - r/${sub}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6f7;color:#1a1a1a;min-height:100vh}.header{height:58px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;padding:0 24px}.header-logo{font-size:15px;font-weight:600}.header-logo span{color:#0051c3}.container{max-width:1000px;margin:0 auto;padding:24px 16px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}.stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px}.stat-card .label{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}.stat-card .value{font-size:28px;font-weight:600}.section{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:16px}.section h2{font-size:16px;font-weight:600;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #f0f0f0}th{font-weight:600;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em}.empty{color:#9ca3af;font-size:14px;padding:20px;text-align:center}.search-box{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:16px}</style>
</head><body>
<div class="header"><div class="header-logo"><span>Scan Slop</span> / r/${sub}</div></div>
<div class="container">
<div class="stats">
<div class="stat-card"><div class="label">Total verifications</div><div class="value">${data.total||0}</div></div>
<div class="stat-card"><div class="label">Today</div><div class="value">${data.today||0}</div></div>
<div class="stat-card"><div class="label">Unique users</div><div class="value">${data.uniqueUsers||0}</div></div>
</div>
<div class="search-box">
<form onsubmit="goUser(event)" style="display:flex;gap:8px;align-items:center">
<input id="search-input" type="text" placeholder="Search username..." style="flex:1;padding:8px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:14px">
<button type="submit" style="padding:8px 20px;background:#0051c3;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500">Search</button>
</form>
</div>
<script>
function goUser(e) {
  e.preventDefault();
  const u = document.getElementById('search-input').value.trim().replace(/^u\\//, '').replace(/^\\/?u\\//, '');
  if (!u) return;
  window.location.href = '/dashboard/user?${qs}&username=' + encodeURIComponent(u);
}
</script>
<div class="section"><h2>Recent verifications</h2>
${rows?`<table><thead><tr><th>User</th><th>Country</th><th>City</th><th>Network</th><th>Bot?</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>`:'<div class="empty">No data yet</div>'}
</div>
<div class="section"><h2>High activity users (3+ captcha page visits in 7 days)</h2>
${suspRows?`<table><thead><tr><th>User</th><th>Visits</th><th>Unique IPs</th><th>Countries</th></tr></thead><tbody>${suspRows}</tbody></table>`:'<div class="empty">No high activity detected</div>'}
</div></div></body></html>`;
}

function renderUserPage(sub, username, key, t, visits, ipReps, links, bans, riskScore) {
  const ipRows = Object.entries(ipReps).map(([ip, rep]) => {
    const proxy = rep?.is_proxy ? '<span style="color:#dc2626;font-weight:600">Yes</span>' : 'No';
    return `<tr><td>${ip}</td><td>${rep?.country || ""}</td><td>${rep?.isp || ""}</td><td>${proxy}</td></tr>`;
  }).join("");

  const linkRows = (links||[]).map(l => {
    const id = l.source_id.replace(/^t[13]_/, "");
    const postId = (l.post_id || "").replace(/^t3_/, "");
    let url;
    if (l.source_type === "post") {
      url = `https://www.reddit.com/r/${sub}/comments/${id}/`;
    } else if (postId) {
      url = `https://www.reddit.com/r/${sub}/comments/${postId}/comment/${id}/`;
    } else {
      url = `https://www.reddit.com/r/${sub}/comments/`;
    }
    return `<tr><td>${l.domain}</td><td>${l.source_type}</td><td><a href="${url}" target="_blank" style="color:#0051c3;text-decoration:none">View ${l.source_type}</a></td><td>${l.detected_at}</td></tr>`;
  }).join("");
  const banRows = (bans||[]).map(b => `<tr><td>${b.action}</td><td>${b.reason || ""}</td><td>${b.duration ? b.duration + ' days' : 'permanent'}</td><td>${b.banned_at}</td></tr>`).join("");

  const rows = visits.map(v => {
    const rep = ipReps[v.ip];
    const proxyBadge = rep?.is_proxy ? ' <span style="color:#dc2626">⚠</span>' : '';
    return `<tr><td>${v.ip}${proxyBadge}</td><td>${v.country}</td><td>${v.city||''}</td><td>${v.asn_org||''}</td><td>${v.visited_at}</td></tr>`;
  }).join("");

  const riskBadge = riskScore >= 50
    ? `<span style="background:#fee2e2;color:#991b1b;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600">HIGH RISK - ${riskScore}% proxy visits</span>`
    : riskScore > 0
    ? `<span style="background:#fef3c7;color:#92400e;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600">${riskScore}% proxy visits</span>`
    : `<span style="background:#d1fae5;color:#065f46;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600">Clean</span>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scan Slop - u/${username}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6f7;color:#1a1a1a;min-height:100vh}.header{height:58px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;padding:0 24px;gap:16px}.header-logo{font-size:15px;font-weight:600}.header-logo span{color:#0051c3}.back{font-size:13px;color:#0051c3;text-decoration:none}.container{max-width:1100px;margin:0 auto;padding:24px 16px}.section{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin-bottom:16px}.section h2{font-size:16px;font-weight:600;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #f0f0f0;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}th{font-weight:600;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em}.empty{color:#9ca3af;font-size:14px;padding:20px;text-align:center}.user-header{display:flex;align-items:center;gap:12px;margin-bottom:20px}.user-header h1{font-size:20px;font-weight:600}.user-header a{font-size:13px;color:#0051c3;text-decoration:none}.user-header button{padding:6px 14px;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer}.ban-btn{background:#dc2626;color:#fff}.ban-btn:hover{background:#b91c1c}.unban-btn{background:#f59e0b;color:#fff}.unban-btn:hover{background:#d97706}.approve-btn{background:#059669;color:#fff}.approve-btn:hover{background:#047857}.revoke-btn{background:#6b7280;color:#fff}.revoke-btn:hover{background:#4b5563}#action-status{font-size:13px;margin-left:8px}</style>
</head><body>
<div class="header">
<div class="header-logo"><span>Scan Slop</span> / r/${sub}</div>
<a class="back" href="/dashboard?sub=${sub}&key=${key}&t=${t}">Back to dashboard</a>
</div>
<div class="container">
<div class="user-header">
<h1>u/${username}</h1>
<a href="https://www.reddit.com/user/${username}" target="_blank">View on Reddit</a>
<button class="ban-btn" onclick="banUser()">Ban user</button>
<button class="unban-btn" onclick="unbanUser()">Unban</button>
<button class="approve-btn" onclick="approveUser()">Approve user</button>
<button class="revoke-btn" onclick="revokeUser()">Reset verification</button>
<span id="action-status"></span>
</div>
<script>
async function doAction(action) {
  let params = null;
  if (action === 'ban') {
    const categories = ['Low effort', 'Spam', 'Link spam', 'Harassment', 'Rule violation', 'Bot account', 'Other'];
    const category = prompt('Ban category:\\n' + categories.map((c,i)=>(i+1)+'. '+c).join('\\n') + '\\n\\nEnter number (1-7):', '1');
    if (category === null) return;
    const idx = parseInt(category) - 1;
    const reason = categories[idx] || 'Other';
    const days = prompt('Ban duration in days (0 = permanent):', '28');
    if (days === null) return;
    params = { duration: parseInt(days) || 0, reason };
  }
  const res = await fetch('/dashboard/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sub: '${sub}',
      key: '${key}',
      t: '${t}',
      action,
      target: '${username}',
      params,
    }),
  });
  const data = await res.json();
  const s = document.getElementById('action-status');
  s.textContent = data.ok ? 'Queued. Action will complete within 1 minute.' : 'Error: ' + (data.error || 'unknown');
  s.style.color = data.ok ? '#059669' : '#dc2626';
}
function banUser() { doAction('ban'); }
function unbanUser() { doAction('unban'); }
function approveUser() { doAction('approve'); }
function revokeUser() {
  if (confirm('Reset verification for this user? They will have to re-verify on their next post or comment.')) doAction('revoke');
}
</script>
<div style="margin-bottom:20px">${riskBadge}</div>
<div class="section"><h2>IP addresses (${Object.keys(ipReps).length})</h2>
${ipRows?`<table><thead><tr><th>IP</th><th>Country</th><th>ISP</th><th>Proxy</th></tr></thead><tbody>${ipRows}</tbody></table>`:'<div class="empty">No IPs recorded</div>'}
</div>
<div class="section"><h2>Promoted links (${(links||[]).length})</h2>
${linkRows?`<table><thead><tr><th>Domain</th><th>Type</th><th>Source</th><th>When</th></tr></thead><tbody>${linkRows}</tbody></table>`:'<div class="empty">No links detected</div>'}
</div>
<div class="section"><h2>Ban history (${(bans||[]).length})</h2>
${banRows?`<table><thead><tr><th>Action</th><th>Reason</th><th>Duration</th><th>When</th></tr></thead><tbody>${banRows}</tbody></table>`:'<div class="empty">No bans</div>'}
</div>
<div class="section"><h2>Verification visits (${visits.length})</h2>
${rows?`<table><thead><tr><th>IP</th><th>Country</th><th>City</th><th>Network</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>`:'<div class="empty">No visits recorded</div>'}
</div></div></body></html>`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#F6821F"/><path stroke="white" stroke-width="1.5" fill="none" d="M11.38 18.378q0-.225.184-.465l6.392-7.895q.184-.233.397-.28a.55.55 0 0 1 .382.04q.171.09.24.294.068.199-.041.472L16.855 16.149h3.958q.232 0 .377.144.15.137.15.355 0 .226-.185.458L14.764 25.01q-.185.225-.397.273a.488.488 0 0 1-.622-.328q-.068-.198.041-.478L15.864 18.87H11.906a.55.55 0 0 1-.383-.137.48.48 0 0 1-.143-.355" transform="translate(0,-2)"/></svg>`;

export default {
  async fetch(request, env) {
    // Bind secrets from env to module-level vars
    CAPTCHA_SECRET_KEY = env.CAPTCHA_SECRET_KEY || "";
    TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || "";
    TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || "";

    const url = new URL(request.url);

    if (url.pathname === "/health") return new Response("ok");

    // --- Serve static assets from KV ---
    if (url.pathname.startsWith("/assets/")) {
      const key = url.pathname.slice("/assets/".length);
      const data = await env.ASSETS.get(key, "arrayBuffer");
      if (!data) return new Response("Not found", { status: 404 });
      const ct = key.endsWith(".gif") ? "image/gif" : key.endsWith(".png") ? "image/png" : "image/jpeg";
      return new Response(data, {
        headers: { "Content-Type": ct, "Cache-Control": "public, max-age=604800" },
      });
    }

    // --- Page aimed at users recommending to mods ---
    if (url.pathname === "/reddit-add-scanslop") {
      return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Help your subreddit fight bots</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;color:#1a1a1a;line-height:1.6}
.container{max-width:720px;margin:0 auto;padding:48px 24px 80px}
h1{font-size:32px;font-weight:700;margin-bottom:12px;letter-spacing:-0.02em}
.intro{font-size:16px;color:#6b7280;margin-bottom:48px}
.section{margin-bottom:48px}
.section h2{font-size:20px;font-weight:600;margin-bottom:12px}
.section p{font-size:15px;color:#404040;margin-bottom:16px}
.section img{max-width:100%;border-radius:8px;border:1px solid #e5e7eb;display:block;margin-top:16px}
.cta{background:#f0f9ff;border:1px solid #bae6fd;border-radius:12px;padding:28px;margin-top:40px}
.cta h3{font-size:20px;font-weight:600;margin-bottom:10px;color:#0c4a6e}
.cta p{font-size:15px;color:#075985;margin-bottom:16px}
.cta .template{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;font-size:14px;color:#404040;margin-top:16px;white-space:pre-line}
.btn{display:inline-block;padding:10px 24px;background:#0051c3;color:#fff;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px}
.btn:hover{background:#003d94}
</style></head><body>
<div class="container">
<h1>Tired of bots in your subreddit?</h1>
<p class="intro">Scan Slop is a free tool that automatically blocks spam and AI bot content. You can ask your moderators to install it.</p>

<div class="section">
<h2>1. Captcha verification</h2>
<p>New users are asked to prove they're human before posting or commenting. The bot removes their content and leaves a sticky comment with a captcha link.</p>
<img src="/assets/captcha-verification.jpg" alt="Captcha verification">
<img src="/assets/captcha-page.gif" alt="Captcha page">
</div>

<div class="section">
<h2>2. Link spam detection</h2>
<p>If a user keeps promoting the same domain, the bot warns them first, then removes their content and bans if they continue.</p>
<img src="/assets/link-spam-warning.jpg" alt="Link spam warning">
</div>

<div class="cta">
<h3>Help your subreddit</h3>
<p>Message the moderators of your favorite subreddit and tell them about Scan Slop. Takes 2 minutes to install and it works automatically.</p>
<div class="template">Hi mods,

I came across Scan Slop, a free Reddit app that blocks bot spam automatically using captcha verification and link spam detection. It seems like a good fit for our subreddit.

Install page: https://developers.reddit.com/apps/scanslop
How it works: https://scanslop.com/reddit-how-it-works

Could you take a look?</div>
<p style="margin-top:20px;margin-bottom:0"><a class="btn" href="https://developers.reddit.com/apps/scanslop" target="_blank">View Scan Slop on Reddit</a></p>
</div>

</div></body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, max-age=3600" } });
    }

    // --- How it works page ---
    if (url.pathname === "/reddit-how-it-works") {
      return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scan Slop - How it works</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;color:#1a1a1a;line-height:1.6}
.container{max-width:720px;margin:0 auto;padding:48px 24px 80px}
h1{font-size:32px;font-weight:700;margin-bottom:12px;letter-spacing:-0.02em}
.intro{font-size:16px;color:#6b7280;margin-bottom:48px}
.section{margin-bottom:48px}
.section h2{font-size:20px;font-weight:600;margin-bottom:12px}
.section p{font-size:15px;color:#404040;margin-bottom:16px}
.section img{max-width:100%;border-radius:8px;border:1px solid #e5e7eb;display:block;margin-top:16px}
.cta{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:24px;text-align:center;margin-top:40px}
.cta h3{font-size:18px;font-weight:600;margin-bottom:8px}
.cta p{font-size:14px;color:#6b7280;margin-bottom:16px}
.btn{display:inline-block;padding:10px 24px;background:#0051c3;color:#fff;border-radius:8px;text-decoration:none;font-weight:500;font-size:14px}
.btn:hover{background:#003d94}
.hint{font-size:13px;color:#9ca3af;margin-top:12px}
.social-proof{background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px 20px;margin-bottom:40px}
.social-proof strong{display:block;font-size:14px;color:#0c4a6e;margin-bottom:4px}
.social-proof p{font-size:14px;color:#075985;margin:0}
.social-proof a{color:#0369a1;text-decoration:none;font-weight:500}
.social-proof a:hover{text-decoration:underline}
</style></head><body>
<div class="container">
<h1>Scan Slop</h1>
<p class="intro">A captcha + link spam bot for subreddit moderators.</p>

<div class="social-proof">
<strong>Trusted by large communities</strong>
<p>Already running on <a href="https://www.reddit.com/r/SaaS" target="_blank">r/SaaS</a> (660k+ members) and <a href="https://www.reddit.com/r/devops" target="_blank">r/DevOps</a> (~500k members), where it has dramatically reduced spam and AI-generated bot content.</p>
</div>

<div class="section">
<h2>1. Captcha verification</h2>
<p>New users are asked to prove they're human before posting or commenting. The bot removes their content and leaves a sticky comment with a captcha link.</p>
<img src="/assets/captcha-verification.jpg" alt="Captcha verification">
<img src="/assets/captcha-page.gif" alt="Captcha page">
</div>

<div class="section">
<h2>2. Link spam detection</h2>
<p>If a user keeps promoting the same domain, the bot warns them first, then removes their content and bans if they continue.</p>
<img src="/assets/link-spam-warning.jpg" alt="Link spam warning">
</div>

<div class="cta">
<h3>Install Scan Slop</h3>
<p>Configure thresholds, ban durations, verification rules, and more.</p>
<a class="btn" href="https://developers.reddit.com/apps/scanslop" target="_blank">Install from Reddit Developer Platform</a>
<div class="hint">See the app page on Reddit Developer Platform to read about all features and settings.</div>
</div>

</div></body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, max-age=3600" } });
    }

    // --- Legal pages ---
    if (url.pathname === "/terms") {
      return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Terms of Service - Scan Slop</title>
<style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1a1a}h1{font-size:24px}h2{font-size:18px;margin-top:24px}a{color:#0051c3}</style>
</head><body>
<h1>Terms of Service</h1>
<p>Last updated: April 19, 2026</p>
<h2>1. Service</h2>
<p>Scan Slop is a Reddit moderation tool that provides captcha verification and spam detection for subreddits. The service is provided "as is" without warranties.</p>
<h2>2. Usage</h2>
<p>Scan Slop may only be installed by subreddit moderators on subreddits they moderate. Users verify via the captcha interface to post or comment in subreddits where Scan Slop is active.</p>
<h2>3. Data</h2>
<p>See our <a href="/privacy">Privacy Policy</a> for details on data collection and use.</p>
<h2>4. Termination</h2>
<p>We may suspend or terminate the service at any time without notice.</p>
<h2>5. Contact</h2>
<p>Questions: contact via Reddit modmail to the installing subreddit's moderators.</p>
</body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, max-age=3600" } });
    }

    if (url.pathname === "/privacy") {
      return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Privacy Policy - Scan Slop</title>
<style>body{font-family:-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1a1a}h1{font-size:24px}h2{font-size:18px;margin-top:24px}a{color:#0051c3}</style>
</head><body>
<h1>Privacy Policy</h1>
<p>Last updated: April 19, 2026</p>
<h2>1. Scope</h2>
<p>This Privacy Policy describes how Scan Slop handles information when you interact with a subreddit that has the service enabled for moderation purposes.</p>
<h2>2. Information</h2>
<p>When users interact with the service, Scan Slop may collect technical signals and metadata necessary to operate the service, detect automated abuse, and assist subreddit moderators. The specific signals collected, their processing, and their retention are determined by operational needs and may change to improve accuracy.</p>
<h2>3. Purpose</h2>
<p>All information is used exclusively to support subreddit moderation: preventing spam, detecting bots, and enforcing subreddit rules. Information is accessible only to moderators of the subreddit where the interaction occurred.</p>
<h2>4. Retention</h2>
<p>Information is retained only as long as needed for moderation and abuse detection purposes.</p>
<h2>5. Sharing</h2>
<p>We do not sell information. We do not share information with third parties except as necessary to operate the service (e.g. infrastructure providers).</p>
<h2>6. Your choices</h2>
<p>If you do not wish to interact with the service, do not post or comment in subreddits where it is active.</p>
<h2>7. Contact</h2>
<p>For questions or requests, contact the moderators of the subreddit where you encountered the service via Reddit modmail.</p>
</body></html>`, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, max-age=3600" } });
    }
    if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.svg") {
      return new Response(FAVICON, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=604800" } });
    }

    // --- Dashboard (key-based, per-sub) ---
    if (url.pathname === "/dashboard") {
      const sub = url.searchParams.get("sub");
      const key = url.searchParams.get("key");
      if (!sub || !key) {
        return new Response("Missing sub or key parameter", { status: 400, headers: { "Content-Type": "text/plain" } });
      }

      const t = url.searchParams.get("t");
      if (!(await validateDashboardKey(sub, key, t))) {
        return new Response("Invalid or expired dashboard link. Get a fresh link from the 'ScanSlop Dashboard' menu option in your subreddit.", { status: 403, headers: { "Content-Type": "text/plain" } });
      }

      const total = await env.DB.prepare("SELECT COUNT(*) as count FROM visits WHERE subreddit = ?").bind(sub).first();
      const today = await env.DB.prepare("SELECT COUNT(*) as count FROM visits WHERE subreddit = ? AND visited_at > datetime('now', '-1 day')").bind(sub).first();
      const uniqueUsers = await env.DB.prepare("SELECT COUNT(DISTINCT username) as count FROM visits WHERE subreddit = ?").bind(sub).first();
      const visits = await env.DB.prepare("SELECT username, country, city, asn_org, is_bot, visited_at FROM visits WHERE subreddit = ? ORDER BY visited_at DESC LIMIT 50").bind(sub).all();
      const suspicious = await env.DB.prepare(
        `SELECT username, COUNT(*) as visit_count, COUNT(DISTINCT ip) as unique_ips,
         GROUP_CONCAT(DISTINCT country) as countries
         FROM visits WHERE subreddit = ? AND visited_at > datetime('now', '-7 days')
         AND username NOT IN ('AutoModerator', 'scanslop')
         GROUP BY username HAVING visit_count > 3 ORDER BY visit_count DESC LIMIT 20`
      ).bind(sub).all();

      return new Response(renderDashboard(sub, {
        key,
        t,
        total: total?.count || 0,
        today: today?.count || 0,
        uniqueUsers: uniqueUsers?.count || 0,
        visits: visits.results,
        suspicious: suspicious.results,
      }), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // --- User detail page ---
    if (url.pathname === "/dashboard/user") {
      const sub = url.searchParams.get("sub");
      const key = url.searchParams.get("key");
      const username = url.searchParams.get("username");
      if (!sub || !key || !username) return new Response("Missing parameters", { status: 400 });

      const t = url.searchParams.get("t");
      if (!(await validateDashboardKey(sub, key, t))) return new Response("Invalid or expired dashboard link", { status: 403 });

      // Sync new events from Telegram first
      await syncEventsFromTelegram(env);

      const visits = await env.DB.prepare(
        "SELECT ip, country, city, asn_org, user_agent, is_bot, visited_at FROM visits WHERE subreddit = ? AND username = ? ORDER BY visited_at DESC LIMIT 100"
      ).bind(sub, username).all();

      const links = await env.DB.prepare(
        "SELECT domain, source_type, source_id, post_id, detected_at FROM link_promotions WHERE subreddit = ? AND username = ? ORDER BY detected_at DESC LIMIT 100"
      ).bind(sub, username).all();

      const bans = await env.DB.prepare(
        "SELECT action, reason, duration, banned_at FROM ban_events WHERE subreddit = ? AND username = ? ORDER BY banned_at DESC LIMIT 50"
      ).bind(sub, username).all();

      // Enrich IPs with reputation
      const uniqueIps = [...new Set(visits.results.map(v => v.ip))];
      const ipReps = {};
      let proxyCount = 0;
      for (const ip of uniqueIps) {
        const rep = await getIpReputation(env, ip);
        ipReps[ip] = rep;
        if (rep?.is_proxy) proxyCount++;
      }
      const riskScore = uniqueIps.length > 0 ? Math.round((proxyCount / uniqueIps.length) * 100) : 0;

      return new Response(renderUserPage(sub, username, key, t, visits.results, ipReps, links.results, bans.results, riskScore), {
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    }

    // --- Captcha page ---
    if (url.pathname.startsWith("/c/")) {
      const token = url.pathname.slice(3);
      const result = simpleDecode(token, CAPTCHA_SECRET_KEY);
      if (!result) return new Response("Invalid or expired verification link.", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "public, max-age=3600" } });

      const tokenAge = Date.now() - result.timestamp;
      if (tokenAge > 86400000) return new Response("This verification link has expired.", { status: 410, headers: { "Content-Type": "text/plain" } });

      const { code, username, subreddit } = result;
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const country = request.headers.get("CF-IPCountry") || "unknown";
      const city = request.cf?.city || "unknown";
      const asn = request.cf?.asn || 0;
      const asnOrg = request.cf?.asOrganization || "unknown";
      const userAgent = request.headers.get("User-Agent") || "unknown";
      const isBot = request.cf?.botManagement?.score < 30 ? 1 : 0;

      try {
        await env.DB.prepare(
          "INSERT INTO visits (username, ip, country, city, asn, asn_org, user_agent, is_bot, visited_at, subreddit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(username, ip, country, city, asn, asnOrg, userAgent, isBot, new Date().toISOString(), subreddit).run();
      } catch (e) { console.error("D1 insert error:", e); }

      const svg = generateCaptchaSVG(code);
      return new Response(renderCaptchaPage(btoa(svg)), {
        headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store, no-cache, must-revalidate" },
      });
    }

    // --- API (internal, key-based) ---
    if (url.pathname.startsWith("/api/")) {
      const apiKey = request.headers.get("X-API-Key");
      if (apiKey !== CAPTCHA_SECRET_KEY) return Response.json({ error: "unauthorized" }, { status: 401 });

      if (url.pathname === "/api/visits") {
        const username = url.searchParams.get("username");
        const sub = url.searchParams.get("sub");
        let q = "SELECT * FROM visits WHERE 1=1", b = [];
        if (username) { q += " AND username = ?"; b.push(username); }
        if (sub) { q += " AND subreddit = ?"; b.push(sub); }
        q += " ORDER BY visited_at DESC LIMIT 50";
        return Response.json((await env.DB.prepare(q).bind(...b).all()).results);
      }
      if (url.pathname === "/api/suspicious") {
        const sub = url.searchParams.get("sub");
        let q = `SELECT ip, COUNT(DISTINCT username) as unique_users, GROUP_CONCAT(DISTINCT username) as usernames FROM visits WHERE visited_at > datetime('now', '-7 days') AND username NOT IN ('AutoModerator', 'scanslop')`, b = [];
        if (sub) { q += " AND subreddit = ?"; b.push(sub); }
        q += " GROUP BY ip HAVING unique_users > 3 ORDER BY unique_users DESC LIMIT 50";
        return Response.json((await env.DB.prepare(q).bind(...b).all()).results);
      }
      if (url.pathname === "/api/stats") {
        const sub = url.searchParams.get("sub");
        const w = sub ? "WHERE subreddit = ?" : "", b = sub ? [sub] : [];
        const total = await env.DB.prepare(`SELECT COUNT(*) as count FROM visits ${w}`).bind(...b).first();
        const today = await env.DB.prepare(`SELECT COUNT(*) as count FROM visits ${w ? w + " AND" : "WHERE"} visited_at > datetime('now', '-1 day')`).bind(...b).first();
        const uniqueUsers = await env.DB.prepare(`SELECT COUNT(DISTINCT username) as count FROM visits ${w}`).bind(...b).first();
        return Response.json({ total_visits: total.count, visits_today: today.count, unique_users: uniqueUsers.count });
      }
      // Generate dashboard key for a sub
      if (url.pathname === "/api/dashboard-key") {
        const sub = url.searchParams.get("sub");
        if (!sub) return Response.json({ error: "missing sub" }, { status: 400 });
        const ts = Date.now();
        const key = await deriveDashboardKey(sub, ts);
        return Response.json({ url: `https://scanslop.com/dashboard?sub=${sub}&key=${key}&t=${ts}` });
      }

      // Devvit fetches pending actions for a sub
      if (url.pathname === "/api/actions/pending") {
        const sub = url.searchParams.get("sub");
        if (!sub) return Response.json({ error: "missing sub" }, { status: 400 });
        const rows = await env.DB.prepare(
          "SELECT id, action, target, params, requested_by FROM pending_actions WHERE subreddit = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 50"
        ).bind(sub).all();
        return Response.json(rows.results);
      }

      // Devvit marks action as done
      if (url.pathname === "/api/actions/complete" && request.method === "POST") {
        const body = await request.json();
        await env.DB.prepare(
          "UPDATE pending_actions SET status = 'done', processed_at = datetime('now') WHERE id = ?"
        ).bind(body.id).run();
        return Response.json({ ok: true });
      }
    }

    // --- Dashboard action endpoint (key-based auth) ---
    if (url.pathname === "/dashboard/action" && request.method === "POST") {
      const body = await request.json();
      const { sub, key, t, action, target, params } = body;
      if (!sub || !key) return Response.json({ error: "missing sub or key" }, { status: 400 });

      if (!(await validateDashboardKey(sub, key, t))) {
        return Response.json({ error: "invalid or expired key" }, { status: 403 });
      }

      if (!["ban", "unban", "approve", "revoke"].includes(action)) {
        return Response.json({ error: "invalid action" }, { status: 400 });
      }

      // Send action to Telegram bot as a relay (Devvit will poll it)
      const payload = `${action}|${sub}|${target}|${params ? JSON.stringify(params) : "{}"}`;
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: payload }),
        });
      } catch (e) {
        return Response.json({ error: "relay failed" }, { status: 500 });
      }

      // Also log in D1 for dashboard history
      await env.DB.prepare(
        "INSERT INTO pending_actions (subreddit, action, target, params, requested_by, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).bind(sub, action, target, params ? JSON.stringify(params) : null, "dashboard").run();

      return Response.json({ ok: true });
    }

    // Landing
    return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scan Slop</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f6f7;margin:0}.c{text-align:center}.c h1{font-size:24px;margin-bottom:8px}.c p{color:#6b7280}</style>
</head><body><div class="c"><h1>Scan Slop</h1><p>Reddit spam prevention for moderators</p></div></body></html>`, {
      headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "public, max-age=3600" },
    });
  },
};
