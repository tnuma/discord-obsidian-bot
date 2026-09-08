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

// 案件一覧の収集（prompterOnly: true の場合は prompter.md が存在する案件のみ）
function getAvailableProjects(prompterOnly = true) {
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

    if (prompterOnly) {
        return list.filter(p => Boolean(p.files.prompter));
    }
    return list;
}

// Markdownの本文をブロック構造化HTMLに変換（段落・【間】・キューの個別認識）
function convertMarkdownToPrompterHTML(rawContent) {
    let text = rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    text = text.replace(/<!--[\s\S]*?-->/g, '');

    // 空行（2つ以上の改行）でスピーチブロックに分割
    const rawChunks = text.split(/\r?\n\s*\r?\n+/);
    const htmlBlocks = [];
    let blockIndex = 0;

    for (let chunk of rawChunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;

        // 進行キュー（〔...〕）
        if (trimmed.startsWith('〔') && trimmed.endsWith('〕')) {
            htmlBlocks.push(`<div class="p-cue">${escapeHTML(trimmed)}</div>`);
            continue;
        }

        // 大見出し
        if (trimmed.startsWith('# ')) {
            htmlBlocks.push(`<h1 class="p-h1">${escapeHTML(trimmed.slice(2))}</h1>`);
            continue;
        }
        // 中見出し
        if (trimmed.startsWith('## ')) {
            htmlBlocks.push(`<h2 class="p-h2">${escapeHTML(trimmed.slice(3))}</h2>`);
            continue;
        }
        if (trimmed.startsWith('### ')) {
            htmlBlocks.push(`<h3 class="p-h3">${escapeHTML(trimmed.slice(4))}</h3>`);
            continue;
        }

        // 【間】ポーズ
        if (trimmed === '【間】' || trimmed.startsWith('【間】')) {
            htmlBlocks.push(`
                <div class="speech-block is-pause" data-index="${blockIndex++}">
                    <div class="pause-box">⏳ 【間】（息継ぎ・沈黙）</div>
                </div>
            `);
            continue;
        }

        // 区切り線
        if (trimmed.includes('━━━') || trimmed === '---') {
            htmlBlocks.push(`<div class="p-divider"></div>`);
            continue;
        }

        // 凡例や引用
        if (trimmed.startsWith('>')) {
            htmlBlocks.push(`<blockquote class="p-quote">${escapeHTML(trimmed.replace(/^>\s*/, ''))}</blockquote>`);
            continue;
        }

        // 通常のセリフ段落（複数行の改行を保持）
        const lines = trimmed.split('\n').map(l => formatInlineMarkdown(l.trim())).join('<br>');
        htmlBlocks.push(`
            <div class="speech-block" data-index="${blockIndex++}">
                <p class="speech-text">${lines}</p>
            </div>
        `);
    }

    return htmlBlocks.join('\n');
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
            <p class="subtitle">収録用台本（prompter.md）が用意された案件一覧</p>
        </header>

        <div class="projects-list">
            ${projects.length > 0 ? projectCards : '<p style="text-align:center; padding:40px; color:#94a3b8; line-height:1.8;">現在 prompter.md（専用台本）が用意された案件はありません。<br><span style="font-size:12px; color:#64748b;">案件フォルダに prompter.md を作成すると自動表示されます</span></p>'}
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
            scroll-behavior: smooth;
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

        /* 目線ガイドライン (上部30%付近) */
        #reading-guide {
            position: fixed;
            top: 30%;
            left: 0;
            right: 0;
            height: 2px;
            background: linear-gradient(90deg, transparent, rgba(239, 68, 68, 0.4) 15%, rgba(239, 68, 68, 0.9) 50%, rgba(239, 68, 68, 0.4) 85%, transparent);
            pointer-events: none;
            z-index: 100;
        }

        /* スクロール本文エリア */
        #prompter-container {
            width: 100%;
            padding: 30vh 20px 65vh 20px;
            max-width: 820px;
            margin: 0 auto;
            transition: transform 0.2s;
        }
        #prompter-container.mirrored {
            transform: scaleX(-1);
        }

        /* スピーチブロック（一節・段落）のスタイリング */
        .speech-block {
            padding: 16px 20px;
            margin-bottom: 36px;
            border-radius: 12px;
            border-left: 4px solid transparent;
            opacity: 0.22;
            filter: blur(0.4px);
            transform: scale(0.97);
            transition: opacity 0.25s ease, transform 0.25s ease, filter 0.25s ease, background 0.25s ease;
            cursor: pointer;
        }

        /* アクティブ（今読むべきブロック）の強調ハイライト */
        .speech-block.active {
            opacity: 1;
            filter: none;
            transform: scale(1.01);
            color: #ffffff;
            background: rgba(251, 191, 36, 0.08);
            border-left: 5px solid #f59e0b;
            box-shadow: 0 4px 24px rgba(0,0,0,0.6);
        }
        .speech-block.active .speech-text {
            color: #ffffff;
            font-weight: 700;
        }

        /* 【間】ポーズのスタイリング */
        .speech-block.is-pause {
            text-align: center;
            padding: 12px;
            margin-bottom: 40px;
        }
        .pause-box {
            display: inline-block;
            color: #f87171;
            font-size: 0.85em;
            font-weight: 800;
            padding: 6px 16px;
            background: rgba(239, 68, 68, 0.1);
            border: 1px dashed rgba(239, 68, 68, 0.4);
            border-radius: 20px;
            letter-spacing: 0.05em;
        }
        .speech-block.is-pause.active {
            border-left: 5px solid #ef4444;
            background: rgba(239, 68, 68, 0.15);
        }
        .speech-block.is-pause.active .pause-box {
            background: #ef4444;
            color: #ffffff;
            border-style: solid;
        }

        /* タイポグラフィ */
        .speech-text {
            font-size: 1em;
            line-height: 1.8;
            letter-spacing: 0.04em;
        }
        .p-cue {
            font-size: 0.8em;
            color: #60a5fa;
            font-weight: 800;
            letter-spacing: 0.05em;
            margin: 40px 0 12px 0;
            opacity: 0.85;
        }
        .p-h1 {
            font-size: 1.3em;
            font-weight: 900;
            color: #f59e0b;
            margin: 40px 0 20px 0;
            border-bottom: 2px solid #333;
            padding-bottom: 8px;
        }
        .p-h2 {
            font-size: 1.15em;
            font-weight: 800;
            color: #60a5fa;
            margin: 32px 0 16px 0;
        }
        .p-bold { color: #fbbf24; font-weight: 900; }
        .p-link { color: #38bdf8; border-bottom: 1px dotted #38bdf8; }
        .p-divider {
            height: 1px;
            background: #27272a;
            margin: 40px 0;
        }
        .p-quote {
            border-left: 4px solid #4b5563;
            padding: 8px 16px;
            margin: 20px 0;
            color: #9ca3af;
            font-size: 0.85em;
        }

        /* 画面右上の情報バー */
        #top-bar {
            position: fixed;
            top: 0; left: 0; right: 0;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: linear-gradient(180deg, rgba(0,0,0,0.85) 0%, transparent 100%);
            z-index: 300;
        }
        .back-btn {
            color: #a1a1aa;
            text-decoration: none;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .mode-indicator {
            font-size: 12px;
            font-weight: 700;
            padding: 3px 8px;
            border-radius: 6px;
            background: #27272a;
            color: #fbbf24;
        }
        .progress-indicator { font-size: 13px; color: #a1a1aa; font-weight: 700; }

        /* コントロールバー（画面下部） */
        #control-panel {
            position: fixed;
            bottom: 0; left: 0; right: 0;
            background: rgba(18, 18, 24, 0.95);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-top: 1px solid #27272a;
            padding: 10px 14px calc(10px + env(safe-area-inset-bottom)) 14px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            z-index: 300;
            gap: 8px;
        }
        .btn-group { display: flex; align-items: center; gap: 6px; }
        button {
            background: #27272a;
            border: 1px solid #3f3f46;
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            -webkit-tap-highlight-color: transparent;
        }
        button:active { background: #3f3f46; transform: scale(0.95); }

        /* メインアクションボタン */
        #btn-next {
            background: #10b981;
            border-color: #059669;
            color: #fff;
            padding: 9px 18px;
            font-size: 15px;
            font-weight: 800;
            border-radius: 10px;
            flex-grow: 1;
            max-width: 140px;
        }
        #btn-prev {
            background: #374151;
            border-color: #4b5563;
            padding: 9px 14px;
            font-size: 14px;
            font-weight: 700;
            border-radius: 10px;
        }
        #btn-mode {
            background: #312e81;
            border-color: #4338ca;
            color: #c7d2fe;
            font-size: 12px;
            padding: 8px 10px;
        }
        #btn-mode.auto {
            background: #065f46;
            border-color: #047857;
            color: #a7f3d0;
        }

        /* 画面左右のタップゾーン（見えないボタン） */
        #tap-prev-zone {
            position: fixed;
            top: 50px; left: 0; width: 30%; bottom: 65px;
            z-index: 50;
        }
        #tap-next-zone {
            position: fixed;
            top: 50px; right: 0; width: 70%; bottom: 65px;
            z-index: 50;
        }
    </style>
</head>
<body>

    <div id="top-bar">
        <a href="/" class="back-btn">← 案件一覧</a>
        <div class="mode-indicator" id="mode-badge">👆 タップ送りモード</div>
        <div class="progress-indicator" id="progress-text">1 / 1</div>
    </div>

    <div id="reading-guide"></div>

    <!-- 画面タップ用ゾーン -->
    <div id="tap-prev-zone" title="左側タップで前へ"></div>
    <div id="tap-next-zone" title="右側タップで次へ"></div>

    <div id="prompter-container">
        ${bodyHTML}
    </div>

    <div id="control-panel">
        <div class="btn-group">
            <button id="btn-font-dec">A-</button>
            <button id="btn-font-inc">A+</button>
            <button id="btn-mirror" title="左右反転">🪞</button>
        </div>

        <div class="btn-group" style="flex-grow:1; justify-content:center;">
            <button id="btn-prev">◀ 前へ</button>
            <button id="btn-next">次へ ▶</button>
        </div>

        <div class="btn-group">
            <button id="btn-mode">👆 ステップ</button>
        </div>
    </div>

    <script>
        // 設定ステート
        let activeIndex = 0;
        let mode = localStorage.getItem('prompter_mode') || 'step'; // 'step' (タップ送り) または 'auto' (自動)
        let fontSize = parseInt(localStorage.getItem('prompter_font_size') || '36', 10);
        let isMirrored = localStorage.getItem('prompter_mirrored') === 'true';
        let autoTimer = null;
        let wakeLock = null;

        const blocks = Array.from(document.querySelectorAll('.speech-block'));
        const container = document.getElementById('prompter-container');
        const btnNext = document.getElementById('btn-next');
        const btnPrev = document.getElementById('btn-prev');
        const btnMode = document.getElementById('btn-mode');
        const btnFontInc = document.getElementById('btn-font-inc');
        const btnFontDec = document.getElementById('btn-font-dec');
        const btnMirror = document.getElementById('btn-mirror');
        const modeBadge = document.getElementById('mode-badge');
        const progressText = document.getElementById('progress-text');
        const tapNextZone = document.getElementById('tap-next-zone');
        const tapPrevZone = document.getElementById('tap-prev-zone');

        // フォントサイズ適用
        function applyFontSize(size) {
            fontSize = Math.min(Math.max(size, 20), 64);
            container.style.fontSize = fontSize + 'px';
            localStorage.setItem('prompter_font_size', fontSize);
            // サイズ変更時に現在位置を再調整
            setTimeout(() => scrollToBlock(activeIndex, false), 50);
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

        // モード切替
        function setMode(newMode) {
            mode = newMode;
            localStorage.setItem('prompter_mode', mode);

            if (mode === 'auto') {
                btnMode.textContent = '🌊 自動流し';
                btnMode.classList.add('auto');
                modeBadge.textContent = '🌊 自動呼吸モード';
                modeBadge.style.color = '#34d399';
                startAutoPlay();
            } else {
                btnMode.textContent = '👆 ステップ';
                btnMode.classList.remove('auto');
                modeBadge.textContent = '👆 タップ送りモード';
                modeBadge.style.color = '#fbbf24';
                stopAutoPlay();
            }
        }

        // 指定ブロックへジャンプ＆フォーカス
        function scrollToBlock(index, smooth = true) {
            if (blocks.length === 0) return;
            activeIndex = Math.min(Math.max(index, 0), blocks.length - 1);

            blocks.forEach((b, idx) => {
                if (idx === activeIndex) {
                    b.classList.add('active');
                } else {
                    b.classList.remove('active');
                }
            });

            // 進行度表示
            progressText.textContent = (activeIndex + 1) + ' / ' + blocks.length;

            // 目線ガイド位置（画面の上部30%）に対象ブロックの先頭を合わせる
            const activeBlock = blocks[activeIndex];
            if (activeBlock) {
                const blockRect = activeBlock.getBoundingClientRect();
                const currentY = window.scrollY || document.documentElement.scrollTop || 0;
                const targetY = currentY + blockRect.top - (window.innerHeight * 0.30);

                window.scrollTo({
                    top: Math.max(0, targetY),
                    behavior: smooth ? 'smooth' : 'auto'
                });
            }
        }

        function nextBlock() {
            if (activeIndex < blocks.length - 1) {
                scrollToBlock(activeIndex + 1, true);
                if (mode === 'auto') scheduleNextAuto();
            } else if (mode === 'auto') {
                stopAutoPlay();
            }
        }

        function prevBlock() {
            if (activeIndex > 0) {
                scrollToBlock(activeIndex - 1, true);
                if (mode === 'auto') scheduleNextAuto();
            }
        }

        // 自動モードの進行スケジュール（セリフ量に応じた呼吸時間）
        function scheduleNextAuto() {
            if (autoTimer) clearTimeout(autoTimer);
            if (mode !== 'auto') return;

            const currentBlock = blocks[activeIndex];
            let delayMs = 3000; // 基本3秒

            if (currentBlock) {
                if (currentBlock.classList.contains('is-pause')) {
                    // 【間】の場合は2秒静止
                    delayMs = 2200;
                } else {
                    // 文字数に応じた時間 (約1文字あたり 100ms + 1.2秒の余白)
                    const textLen = currentBlock.textContent.trim().length;
                    delayMs = Math.min(Math.max(1500 + (textLen * 95), 2500), 10000);
                }
            }

            autoTimer = setTimeout(() => {
                nextBlock();
            }, delayMs);
        }

        function startAutoPlay() {
            requestWakeLock();
            scheduleNextAuto();
        }

        function stopAutoPlay() {
            if (autoTimer) {
                clearTimeout(autoTimer);
                autoTimer = null;
            }
            releaseWakeLock();
        }

        // Wake Lock
        async function requestWakeLock() {
            try {
                if ('wakeLock' in navigator) {
                    wakeLock = await navigator.wakeLock.request('screen');
                }
            } catch (_) {}
        }
        function releaseWakeLock() {
            if (wakeLock) {
                wakeLock.release().catch(() => {});
                wakeLock = null;
            }
        }

        // ボタンイベント
        btnNext.addEventListener('click', (e) => { e.stopPropagation(); nextBlock(); });
        btnPrev.addEventListener('click', (e) => { e.stopPropagation(); prevBlock(); });
        btnFontInc.addEventListener('click', (e) => { e.stopPropagation(); applyFontSize(fontSize + 4); });
        btnFontDec.addEventListener('click', (e) => { e.stopPropagation(); applyFontSize(fontSize - 4); });
        btnMirror.addEventListener('click', (e) => { e.stopPropagation(); applyMirror(!isMirrored); });
        btnMode.addEventListener('click', (e) => {
            e.stopPropagation();
            setMode(mode === 'step' ? 'auto' : 'step');
        });

        // 画面タップ操作
        // 右側（広め）をタップで次へ、左側をタップで前へ
        tapNextZone.addEventListener('click', () => nextBlock());
        tapPrevZone.addEventListener('click', () => prevBlock());

        // 各ブロックを直接タップした場合もそのブロックへジャンプ
        blocks.forEach((block, idx) => {
            block.addEventListener('click', (e) => {
                e.stopPropagation();
                scrollToBlock(idx, true);
                if (mode === 'auto') scheduleNextAuto();
            });
        });

        // キーボード操作
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space' || e.code === 'ArrowDown' || e.code === 'ArrowRight' || e.code === 'Enter') {
                e.preventDefault();
                nextBlock();
            } else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') {
                e.preventDefault();
                prevBlock();
            } else if (e.code === 'KeyM') {
                setMode(mode === 'step' ? 'auto' : 'step');
            }
        });

        // 初期化
        applyFontSize(fontSize);
        applyMirror(isMirrored);
        setMode(mode);
        scrollToBlock(0, false);
        requestWakeLock();
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
        const projects = getAvailableProjects(false);
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
