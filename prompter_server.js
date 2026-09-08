/**
 * prompter_server.js
 * 
 * スマホ・タブレット対応の超軽量Webテレプロンプターサーバー。
 * 外部npmパッケージ不要（Node.js標準の http, fs, path, os のみで動作）。
 * 
 * 機能:
 * - 01_Projects から ready / in-production 案件の台本（prompter.md / script.md）を配信
 * - スマホ全画面オートスクロール（requestAnimationFrameによる滑らかなスクロール）
 * - 画面スリープ防止（Wake Lock API）
 * - 3秒カウントダウン、速度調整、フォントサイズ変更、左右ミラー反転、目線ガイドバー
 * - 設定のlocalStorage保存
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');

// オプショナル依存の安全な読み込み
function loadEnv() {
    try {
        require('dotenv').config({ path: path.join(__dirname, '.env') });
        return;
    } catch (_) {}

    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
                const key = trimmed.slice(0, idx).trim();
                let val = trimmed.slice(idx + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (!process.env[key]) {
                    process.env[key] = val;
                }
            }
        }
    }
}
loadEnv();

const PORT = parseInt(process.env.PROMPTER_PORT || '3333', 10);
const VAULT_PATH = process.env.VAULT_PATH || '/home/tnuma/my-vault';

// ネットワークインターフェースからIPアドレスを取得
function getServerIPs() {
    const interfaces = os.networkInterfaces();
    const ips = { local: [], tailscale: [] };

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                if (iface.address.startsWith('100.')) {
                    ips.tailscale.push(iface.address);
                } else {
                    ips.local.push(iface.address);
                }
            }
        }
    }
    return ips;
}

// 再帰的にディレクトリ内のMarkdownファイルを取得
function getAllMarkdownFiles(dirPath, arrayOfFiles = []) {
    if (!fs.existsSync(dirPath)) return arrayOfFiles;

    const files = fs.readdirSync(dirPath);
    files.forEach(file => {
        const fullPath = path.join(dirPath, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (!file.startsWith('.')) {
                getAllMarkdownFiles(fullPath, arrayOfFiles);
            }
        } else if (file.endsWith('.md') && !file.startsWith('.')) {
            arrayOfFiles.push({
                name: file,
                fullPath,
                mtimeMs: fs.statSync(fullPath).mtimeMs,
            });
        }
    });
    return arrayOfFiles;
}

// 案件一覧の収集
function getAvailableProjects() {
    const projectsDir = path.join(VAULT_PATH, '01_Projects');
    if (!fs.existsSync(projectsDir)) return [];

    const files = getAllMarkdownFiles(projectsDir);
    const projectMap = new Map();

    files.forEach(f => {
        try {
            const content = fs.readFileSync(f.fullPath, 'utf8');
            const titleMatch = content.match(/^title:\s*["']?([^"'\r\n]+)["']?/m) || content.match(/^#\s+([^\r\n]+)/m);
            const statusMatch = content.match(/^status:\s*["']?([^"'\r\n]+)["']?/m);
            const channelMatch = content.match(/^channel:\s*["']?([^"'\r\n]+)["']?/m);

            const status = statusMatch ? statusMatch[1].trim().toLowerCase() : null;
            const title = titleMatch ? titleMatch[1].trim() : path.basename(f.name, '.md');
            const channel = channelMatch ? channelMatch[1].trim() : 'Project';

            // ディレクトリ基準で案件をまとめる
            const relPath = path.relative(projectsDir, f.fullPath);
            const parts = relPath.split(path.sep);
            const channelFolder = parts[0];
            const projectDirName = parts.length > 2 ? parts[1] : (parts.length === 2 ? path.basename(parts[1], '.md') : path.basename(parts[0], '.md'));

            const projectKey = `${channelFolder}/${projectDirName}`;

            if (!projectMap.has(projectKey)) {
                projectMap.set(projectKey, {
                    key: projectKey,
                    title,
                    channel: channelFolder,
                    status: status || 'unknown',
                    files: {},
                    baseDir: path.dirname(f.fullPath),
                    mtimeMs: f.mtimeMs
                });
            }

            const p = projectMap.get(projectKey);
            if (f.name === 'prompter.md') p.files.prompter = f.fullPath;
            if (f.name === 'script.md') p.files.script = f.fullPath;
            if (!p.files.main) p.files.main = f.fullPath;

            if (status) p.status = status;
            if (titleMatch && f.name !== 'prompter.md') p.title = title;
            if (f.mtimeMs > p.mtimeMs) p.mtimeMs = f.mtimeMs;

        } catch (_) {}
    });

    const list = Array.from(projectMap.values());
    list.sort((a, b) => {
        // ready最優先、次にin-production、次にmtime降順
        const scoreA = a.status === 'ready' ? 3 : (a.status === 'in-production' ? 2 : 1);
        const scoreB = b.status === 'ready' ? 3 : (b.status === 'in-production' ? 2 : 1);
        if (scoreA !== scoreB) return scoreB - scoreA;
        return b.mtimeMs - a.mtimeMs;
    });

    return list;
}

// Markdownの本文をプロンプター用プレーンHTMLに変換
function convertMarkdownToPrompterHTML(rawContent) {
    // 1. Frontmatterの除去
    let text = rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

    // 2. 不要なセクション（メタ情報など）の除去
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    const lines = text.split('\n');
    const htmlLines = [];

    for (let line of lines) {
        line = line.trim();
        if (!line) {
            htmlLines.push('<div class="spacer"></div>');
            continue;
        }

        // 見出し
        if (line.startsWith('# ')) {
            htmlLines.push(`<h1 class="p-h1">${escapeHTML(line.slice(2))}</h1>`);
        } else if (line.startsWith('## ')) {
            htmlLines.push(`<h2 class="p-h2">${escapeHTML(line.slice(3))}</h2>`);
        } else if (line.startsWith('### ')) {
            htmlLines.push(`<h3 class="p-h3">${escapeHTML(line.slice(4))}</h3>`);
        } else if (line.startsWith('>')) {
            // 引用
            htmlLines.push(`<blockquote class="p-quote">${escapeHTML(line.replace(/^>\s*/, ''))}</blockquote>`);
        } else if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
            // リスト
            const itemText = line.replace(/^[-*•]\s*/, '');
            htmlLines.push(`<div class="p-list-item"><span class="bullet">•</span> ${formatInlineMarkdown(itemText)}</div>`);
        } else {
            // 通常段落
            htmlLines.push(`<p class="p-para">${formatInlineMarkdown(line)}</p>`);
        }
    }

    return htmlLines.join('\n');
}

function escapeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatInlineMarkdown(str) {
    let s = escapeHTML(str);
    // 太字 **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong class="p-bold">$1</strong>');
    // ルビや注釈 [[Wikilink]]
    s = s.replace(/\[\[(.*?)\]\]/g, '<span class="p-link">$1</span>');
    // コード
    s = s.replace(/`([^`]+)`/g, '<code class="p-code">$1</code>');
    return s;
}

// ==========================================
// 🎨 HTML テンプレート
// ==========================================

function renderIndexPage(projects, ips) {
    const projectCards = projects.map(p => {
        const statusClass = p.status === 'ready' ? 'status-ready' : (p.status === 'in-production' ? 'status-inprod' : 'status-other');
        const statusLabel = p.status === 'ready' ? 'READY（収録待ち）' : (p.status === 'in-production' ? '制作中' : p.status.toUpperCase());
        const hasPrompter = Boolean(p.files.prompter);
        const scriptType = hasPrompter ? '🎬 prompter.md (専用台本)' : '📝 script.md (通常台本)';

        return `
        <a href="/p/${encodeURIComponent(p.key)}" class="project-card ${statusClass}">
            <div class="card-header">
                <span class="status-badge ${statusClass}">${statusLabel}</span>
                <span class="channel-tag">${escapeHTML(p.channel)}</span>
            </div>
            <h2 class="project-title">${escapeHTML(p.title)}</h2>
            <div class="card-footer">
                <span class="script-type">${scriptType}</span>
                <span class="arrow">タップして開始 →</span>
            </div>
        </a>
        `;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>🎬 Teleprompter - 案件選択</title>
    <style>
        :root {
            --bg-color: #0f1117;
            --card-bg: #1a1d27;
            --text-color: #e2e8f0;
            --text-dim: #94a3b8;
            --accent-ready: #10b981;
            --accent-inprod: #f59e0b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            padding: 20px 16px;
            min-height: 100vh;
        }
        .container { max-width: 600px; margin: 0 auto; }
        header { text-align: center; margin-bottom: 24px; padding-top: 10px; }
        h1 { font-size: 24px; font-weight: 800; color: #fff; margin-bottom: 6px; }
        .subtitle { font-size: 13px; color: var(--text-dim); }
        .projects-list { display: flex; flex-direction: column; gap: 14px; }
        .project-card {
            display: block;
            background: var(--card-bg);
            border: 1px solid #2d3748;
            border-radius: 14px;
            padding: 16px 18px;
            text-decoration: none;
            color: inherit;
            transition: transform 0.15s, border-color 0.15s;
            -webkit-tap-highlight-color: transparent;
        }
        .project-card:active { transform: scale(0.98); }
        .project-card.status-ready { border-left: 5px solid var(--accent-ready); }
        .project-card.status-inprod { border-left: 5px solid var(--accent-inprod); }
        .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
        .status-badge {
            font-size: 11px;
            font-weight: 700;
            padding: 3px 8px;
            border-radius: 6px;
            letter-spacing: 0.5px;
        }
        .status-badge.status-ready { background: rgba(16, 185, 129, 0.2); color: #34d399; }
        .status-badge.status-inprod { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
        .status-badge.status-other { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
        .channel-tag { font-size: 12px; color: var(--text-dim); }
        .project-title { font-size: 18px; font-weight: 700; color: #fff; line-height: 1.4; margin-bottom: 12px; }
        .card-footer { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-dim); }
        .arrow { color: #60a5fa; font-weight: 600; }
        .ip-footer {
            margin-top: 36px;
            padding: 16px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 10px;
            font-size: 12px;
            color: var(--text-dim);
            line-height: 1.6;
        }
        .ip-footer strong { color: #fff; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🎬 Web Teleprompter</h1>
            <p class="subtitle">台本を選んでタップすると収録用プロンプターが起動します</p>
        </header>

        <div class="projects-list">
            ${projects.length > 0 ? projectCards : '<p style="text-align:center; padding:40px; color:#94a3b8;">現在 ready または in-production の案件はありません。</p>'}
        </div>

        <div class="ip-footer">
            <strong>📡 接続情報:</strong><br>
            • ローカルWi-Fi: <code>http://pi4.local:${PORT}</code> または <code>http://${ips.local[0] || '192.168.x.x'}:${PORT}</code><br>
            ${ips.tailscale.length > 0 ? `• Tailscale VPN: <code>http://${ips.tailscale[0]}:${PORT}</code>` : ''}
        </div>
    </div>
</body>
</html>`;
}

function renderPrompterPage(project, bodyHTML) {
    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>🎬 ${escapeHTML(project.title)}</title>
    <style>
        html {
            background-color: #000000;
            color: #ffffff;
            overflow-x: hidden;
            overflow-y: auto;
            scroll-behavior: auto !important;
            height: auto;
            min-height: 100%;
        }
        body {
            background-color: #000000;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "BIZ UDPGothic", Meiryo, sans-serif;
            overflow-x: hidden;
            width: 100%;
            min-height: 100vh;
            height: auto;
            margin: 0;
            padding: 0;
            user-select: none;
            -webkit-user-select: none;
        }

        /* 目線ガイドライン (上部32%付近) */
        #reading-guide {
            position: fixed;
            top: 32%;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, rgba(239, 68, 68, 0.45) 20%, rgba(239, 68, 68, 0.8) 50%, rgba(239, 68, 68, 0.45) 80%, transparent);
            pointer-events: none;
            z-index: 100;
            transition: opacity 0.3s;
        }

        /* スクロール本文エリア */
        #prompter-container {
            width: 100%;
            min-height: 100vh;
            padding: 38vh 24px 70vh 24px;
            max-width: 820px;
            margin: 0 auto;
            transition: transform 0.2s;
        }
        #prompter-container.mirrored {
            transform: scaleX(-1);
        }

        /* タイポグラフィ */
        .p-h1 {
            font-size: 1.3em;
            font-weight: 800;
            color: #f59e0b;
            margin: 40px 0 20px 0;
            line-height: 1.3;
            border-bottom: 2px solid #333;
            padding-bottom: 8px;
        }
        .p-h2 {
            font-size: 1.15em;
            font-weight: 700;
            color: #60a5fa;
            margin: 32px 0 16px 0;
            line-height: 1.35;
        }
        .p-h3 {
            font-size: 1.05em;
            font-weight: 700;
            color: #a78bfa;
            margin: 24px 0 12px 0;
        }
        .p-para {
            font-size: 1em;
            line-height: 1.7;
            margin-bottom: 24px;
            letter-spacing: 0.03em;
            font-weight: 500;
        }
        .p-bold {
            color: #fbbf24;
            font-weight: 800;
        }
        .p-quote {
            border-left: 4px solid #4b5563;
            padding: 10px 16px;
            margin: 20px 0;
            background: rgba(255, 255, 255, 0.05);
            font-style: italic;
        }
        .p-list-item {
            font-size: 1em;
            line-height: 1.65;
            margin-bottom: 14px;
            padding-left: 8px;
        }
        .p-list-item .bullet { color: #f59e0b; font-weight: bold; margin-right: 6px; }
        .p-link { color: #38bdf8; border-bottom: 1px dotted #38bdf8; }
        .spacer { height: 20px; }

        /* カウントダウンオーバーレイ */
        #countdown-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 120px;
            font-weight: 900;
            color: #fbbf24;
            z-index: 500;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s;
        }
        #countdown-overlay.show {
            opacity: 1;
            pointer-events: auto;
        }

        /* コントロールバー（画面下部） */
        #control-panel {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: rgba(18, 18, 24, 0.95);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-top: 1px solid #27272a;
            padding: 12px 16px calc(12px + env(safe-area-inset-bottom)) 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            z-index: 300;
            transition: transform 0.3s, opacity 0.3s;
        }
        #control-panel.hidden {
            transform: translateY(100%);
            opacity: 0;
        }

        .btn-group { display: flex; align-items: center; gap: 8px; }
        button {
            background: #27272a;
            border: 1px solid #3f3f46;
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            -webkit-tap-highlight-color: transparent;
        }
        button:active { background: #3f3f46; transform: scale(0.95); }
        #btn-play {
            background: #10b981;
            border-color: #059669;
            padding: 10px 20px;
            font-size: 16px;
            font-weight: 800;
            border-radius: 10px;
        }
        #btn-play.playing {
            background: #ef4444;
            border-color: #dc2626;
        }

        .speed-label {
            font-size: 12px;
            color: #a1a1aa;
            min-width: 48px;
            text-align: center;
        }

        /* 画面右上のクイック切替アイコン */
        #top-bar {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: linear-gradient(180deg, rgba(0,0,0,0.8) 0%, transparent 100%);
            z-index: 300;
            transition: opacity 0.3s;
        }
        #top-bar.hidden { opacity: 0; pointer-events: none; }
        .back-btn {
            color: #a1a1aa;
            text-decoration: none;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .progress-indicator { font-size: 12px; color: #71717a; font-weight: 600; }
    </style>
</head>
<body>

    <div id="top-bar">
        <a href="/" class="back-btn">← 案件一覧</a>
        <div class="progress-indicator" id="progress-text">0%</div>
    </div>

    <div id="reading-guide"></div>

    <div id="countdown-overlay">3</div>

    <div id="prompter-container">
        ${bodyHTML}
    </div>

    <div id="control-panel">
        <div class="btn-group">
            <button id="btn-font-dec">A-</button>
            <button id="btn-font-inc">A+</button>
            <button id="btn-mirror" title="左右反転">🪞</button>
        </div>

        <button id="btn-play">▶ 再生</button>

        <div class="btn-group">
            <button id="btn-speed-dec">−</button>
            <span class="speed-label" id="speed-display">速度 3</span>
            <button id="btn-speed-inc">+</button>
        </div>
    </div>

    <script>
        // 設定ステート
        let isPlaying = false;
        let isCountingDown = false;
        let countdownTimer = null;
        let speed = parseInt(localStorage.getItem('prompter_speed') || '3', 10);
        let fontSize = parseInt(localStorage.getItem('prompter_font_size') || '38', 10);
        let isMirrored = localStorage.getItem('prompter_mirrored') === 'true';
        let animationFrameId = null;
        let lastTimestamp = 0;
        let wakeLock = null;

        // 浮動小数点での累積スクロール位置
        let currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
        let isInternalScroll = false;

        const container = document.getElementById('prompter-container');
        const btnPlay = document.getElementById('btn-play');
        const speedDisplay = document.getElementById('speed-display');
        const btnSpeedInc = document.getElementById('btn-speed-inc');
        const btnSpeedDec = document.getElementById('btn-speed-dec');
        const btnFontInc = document.getElementById('btn-font-inc');
        const btnFontDec = document.getElementById('btn-font-dec');
        const btnMirror = document.getElementById('btn-mirror');
        const countdownOverlay = document.getElementById('countdown-overlay');
        const controlPanel = document.getElementById('control-panel');
        const topBar = document.getElementById('top-bar');
        const progressText = document.getElementById('progress-text');

        // フォントサイズ適用
        function applyFontSize(size) {
            fontSize = Math.min(Math.max(size, 20), 72);
            container.style.fontSize = fontSize + 'px';
            localStorage.setItem('prompter_font_size', fontSize);
        }

        // ミラー反転適用
        function applyMirror(mirrored) {
            isMirrored = mirrored;
            if (isMirrored) {
                container.classList.add('mirrored');
                btnMirror.style.background = '#4f46e5';
            } else {
                container.classList.remove('mirrored');
                btnMirror.style.background = '#27272a';
            }
            localStorage.setItem('prompter_mirrored', isMirrored);
        }

        // 速度更新
        function updateSpeed(newSpeed) {
            speed = Math.min(Math.max(newSpeed, 1), 10);
            speedDisplay.textContent = '速度 ' + speed;
            localStorage.setItem('prompter_speed', speed);
        }

        // Wake Lock（画面スリープ防止）
        async function requestWakeLock() {
            try {
                if ('wakeLock' in navigator) {
                    wakeLock = await navigator.wakeLock.request('screen');
                }
            } catch (err) {}
        }
        function releaseWakeLock() {
            if (wakeLock) {
                wakeLock.release().catch(() => {});
                wakeLock = null;
            }
        }

        // ユーザーの手動スクロール検知（ホイール・タッチ）
        function syncScrollPosition() {
            if (!isInternalScroll) {
                currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
            }
        }
        window.addEventListener('scroll', syncScrollPosition, { passive: true });
        window.addEventListener('wheel', syncScrollPosition, { passive: true });
        window.addEventListener('touchmove', syncScrollPosition, { passive: true });

        // スクロールループ（高精度requestAnimationFrame）
        function scrollStep(timestamp) {
            if (!isPlaying) return;

            if (lastTimestamp) {
                const delta = Math.min(timestamp - lastTimestamp, 100); // 極端なラグ時の飛び跳ね防止

                // 速度 1〜10 (speed 1: 約30px/s 〜 speed 10: 約250px/s)
                const pxPerSecond = 15 + (speed * 22);
                const step = (pxPerSecond * delta) / 1000;

                currentScrollY += step;
                isInternalScroll = true;

                // 複数のスクロール対象に同時適用（Arc / Chrome / Safari / Firefox 完全対応）
                window.scrollTo(0, currentScrollY);
                if (document.documentElement) document.documentElement.scrollTop = currentScrollY;
                if (document.body) document.body.scrollTop = currentScrollY;

                isInternalScroll = false;

                // 進捗更新
                const scrollHeight = Math.max(
                    document.body.scrollHeight,
                    document.documentElement.scrollHeight,
                    container.offsetHeight
                );
                const maxScroll = scrollHeight - window.innerHeight;
                if (maxScroll > 0) {
                    const actualY = window.scrollY || document.documentElement.scrollTop || 0;
                    const percent = Math.min(Math.round((actualY / maxScroll) * 100), 100);
                    progressText.textContent = percent + '%';
                }
            }

            lastTimestamp = timestamp;
            animationFrameId = requestAnimationFrame(scrollStep);
        }

        // 開始・停止
        function startScrolling() {
            if (countdownTimer) {
                clearInterval(countdownTimer);
                countdownTimer = null;
            }
            isCountingDown = false;
            countdownOverlay.classList.remove('show');

            isPlaying = true;
            btnPlay.textContent = '⏸ 停止';
            btnPlay.classList.add('playing');
            progressText.style.color = '#10b981';
            lastTimestamp = 0;
            currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
            requestWakeLock();
            animationFrameId = requestAnimationFrame(scrollStep);
        }

        function stopScrolling() {
            if (countdownTimer) {
                clearInterval(countdownTimer);
                countdownTimer = null;
            }
            isCountingDown = false;
            countdownOverlay.classList.remove('show');

            isPlaying = false;
            btnPlay.textContent = '▶ 再生';
            btnPlay.classList.remove('playing');
            progressText.style.color = '#71717a';
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            releaseWakeLock();
        }

        // カウントダウン付き再生
        function togglePlayWithCountdown() {
            if (isPlaying || isCountingDown) {
                stopScrolling();
            } else {
                isCountingDown = true;
                let count = 3;
                countdownOverlay.textContent = count;
                countdownOverlay.classList.add('show');

                countdownTimer = setInterval(() => {
                    count--;
                    if (count > 0) {
                        countdownOverlay.textContent = count;
                    } else {
                        clearInterval(countdownTimer);
                        countdownTimer = null;
                        startScrolling();
                    }
                }, 750);
            }
        }

        // イベントバインド
        btnPlay.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlayWithCountdown();
        });

        btnSpeedInc.addEventListener('click', (e) => { e.stopPropagation(); updateSpeed(speed + 1); });
        btnSpeedDec.addEventListener('click', (e) => { e.stopPropagation(); updateSpeed(speed - 1); });
        btnFontInc.addEventListener('click', (e) => { e.stopPropagation(); applyFontSize(fontSize + 4); });
        btnFontDec.addEventListener('click', (e) => { e.stopPropagation(); applyFontSize(fontSize - 4); });
        btnMirror.addEventListener('click', (e) => { e.stopPropagation(); applyMirror(!isMirrored); });

        // 画面タップで一時停止/再開（コントロールエリア以外）
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#control-panel') || e.target.closest('#top-bar')) return;
            if (isPlaying || isCountingDown) {
                stopScrolling();
            } else {
                startScrolling();
            }
        });

        // カウントダウンオーバーレイ自体のタップでキャンセル
        countdownOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            stopScrolling();
        });

        // キーボード操作（スペースで再生停止、矢印で速度変更）
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                e.preventDefault();
                togglePlayWithCountdown();
            } else if (e.code === 'ArrowUp') {
                updateSpeed(speed + 1);
            } else if (e.code === 'ArrowDown') {
                updateSpeed(speed - 1);
            }
        });

        // 初期化実行
        applyFontSize(fontSize);
        applyMirror(isMirrored);
        updateSpeed(speed);
        currentScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    </script>
</body>
</html>`;
}

// ==========================================
// 🚀 HTTP サーバー本体
// ==========================================

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const ips = getServerIPs();

    // CORSヘッダー
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    // 1. API: /api/projects
    if (pathname === '/api/projects') {
        const projects = getAvailableProjects();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ projects, ips }));
        return;
    }

    // 2. プロンプター画面: /p/:encodedKey
    if (pathname.startsWith('/p/')) {
        const targetKey = decodeURIComponent(pathname.slice(3));
        const projects = getAvailableProjects();
        const project = projects.find(p => p.key === targetKey || p.key.endsWith(targetKey));

        if (!project) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>404 Not Found</h1><p>指定された案件が見つかりませんでした。<a href="/">一覧に戻る</a></p>');
            return;
        }

        // 台本ファイルの内容を取得（prompter.md 優先、なければ script.md、なければ main）
        const scriptFilePath = project.files.prompter || project.files.script || project.files.main;
        let scriptContent = '';
        try {
            scriptContent = fs.readFileSync(scriptFilePath, 'utf8');
        } catch (e) {
            scriptContent = '# 台本読み込みエラー\n' + e.message;
        }

        const bodyHTML = convertMarkdownToPrompterHTML(scriptContent);
        const html = renderPrompterPage(project, bodyHTML);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    // 3. トップ一覧: /
    if (pathname === '/' || pathname === '/index.html') {
        const projects = getAvailableProjects();
        const html = renderIndexPage(projects, ips);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
    const ips = getServerIPs();
    console.log('==================================================');
    console.log(`🎬 Teleprompter Web Server 起動 (Port: ${PORT})`);
    console.log(`📡 ローカルURL: http://localhost:${PORT}`);
    if (ips.local.length > 0) {
        console.log(`📡 スマホWi-Fi用: http://${ips.local[0]}:${PORT}`);
        console.log(`📡 mDNS (Mac/iOS): http://pi4.local:${PORT}`);
    }
    if (ips.tailscale.length > 0) {
        console.log(`📡 Tailscale用: http://${ips.tailscale[0]}:${PORT}`);
    }
    console.log('==================================================');
});
