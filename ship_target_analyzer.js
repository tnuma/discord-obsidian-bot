/**
 * ship_target_analyzer.js
 * 
 * 最新の週次レビュー（06_Weekly_Reviews）から vidIQ の推奨投稿タイミングを解析し、
 * 01_Projects 内の仕掛かり案件（ready, in-production）と照合して
 * 「本日出すべき案件」「推奨時間帯」「他チャンネルの直近推奨日」を抽出するモジュール。
 */

const fs = require('fs');
const path = require('path');

// オプショナル依存の安全な読み込み
let matter = null;
try { matter = require('gray-matter'); } catch (_) {}

// 曜日マップ
const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// チャンネル識別子の定義
const CHANNEL_CONFIGS = [
    {
        id: 'translation',
        displayName: '翻訳CH「進撃解読」',
        keywords: ['翻訳', '進撃'],
        folderNames: ['Translation'],
        channelTags: ['translation', 'Translation']
    },
    {
        id: 'numa-ch',
        displayName: '個人CH「ぬま」',
        keywords: ['個人', 'ぬま'],
        folderNames: ['Numa_YouTube'],
        channelTags: ['numa-ch', 'Numa_YouTube']
    },
    {
        id: 'nanshindo',
        displayName: '南信堂SNS',
        keywords: ['南信堂'],
        folderNames: ['Nanshindo_SNS'],
        channelTags: ['Nanshindo_SNS', 'nanshindo']
    }
];

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
            const stat = fs.statSync(fullPath);
            arrayOfFiles.push({
                name: file,
                fullPath,
                mtimeMs: stat.mtimeMs,
            });
        }
    });
    return arrayOfFiles;
}

// 最新の週次レビューファイルを取得
function getLatestWeeklyReviewFile(vaultPath) {
    const reviewsDir = path.join(vaultPath, '06_Weekly_Reviews');
    if (!fs.existsSync(reviewsDir)) return null;

    const files = getAllMarkdownFiles(reviewsDir);
    if (files.length === 0) return null;

    files.sort((a, b) => {
        if (a.name > b.name) return -1;
        if (a.name < b.name) return 1;
        return b.mtimeMs - a.mtimeMs;
    });

    return files[0];
}

// Markdownのfrontmatter/タイトル簡易解析
function parseMarkdownBasic(rawContent) {
    let title = null;
    let status = null;
    let statusSince = null;
    let channel = null;

    if (matter) {
        try {
            const parsed = matter(rawContent);
            if (parsed.data) {
                title = parsed.data.title;
                status = parsed.data.status;
                statusSince = parsed.data.status_since;
                channel = parsed.data.channel;
            }
        } catch (_) {}
    }

    if (!title || !status) {
        const titleMatch = rawContent.match(/^title:\s*["']?([^"'\r\n]+)["']?/m);
        if (titleMatch) title = titleMatch[1].trim();

        const statusMatch = rawContent.match(/^status:\s*["']?([^"'\r\n]+)["']?/m);
        if (statusMatch) status = statusMatch[1].trim();

        const sinceMatch = rawContent.match(/^status_since:\s*["']?([^"'\r\n]+)["']?/m);
        if (sinceMatch) statusSince = sinceMatch[1].trim();

        const chMatch = rawContent.match(/^channel:\s*["']?([^"'\r\n]+)["']?/m);
        if (chMatch) channel = chMatch[1].trim();
    }

    if (!title) {
        const h1Match = rawContent.match(/^#\s+([^\r\n]+)/m);
        if (h1Match) title = h1Match[1].trim();
    }

    return { title, status, statusSince, channel };
}

// 週次レビューから推奨投稿タイミングを抽出
function extractPostingTimings(reviewContent) {
    const timings = [];

    // ### 推奨投稿タイミング のセクションを抽出
    const sectionRegex = /###\s*推奨投稿タイミング[\s\S]*?(?=\n## |\n---|$)/i;
    const match = reviewContent.match(sectionRegex);
    if (!match) return timings;

    const sectionText = match[0];
    const lines = sectionText.split('\n');

    for (const line of lines) {
        // 例: - **個人CH「ぬま」**：木 18–21時 ／ 月 15–18時 ／ 水 18–21時
        const lineMatch = line.match(/^[-*]\s*\*\*([^*]+)\*\*\s*[：:]\s*(.+)$/);
        if (!lineMatch) continue;

        const rawChannelName = lineMatch[1].trim();
        const rawSchedule = lineMatch[2].trim();

        // 該当チャンネル設定を特定
        const config = CHANNEL_CONFIGS.find(cfg =>
            cfg.keywords.some(kw => rawChannelName.includes(kw))
        ) || { id: rawChannelName, displayName: rawChannelName };

        // 各時間枠（例: 木 18–21時）を正規表現で抽出
        const slotRegex = /(\*\*)?([日月火水木金土])\s*(\d{1,2}[–-〜]\d{1,2}時)(\*\*)?/g;
        let slotMatch;
        const slots = [];

        while ((slotMatch = slotRegex.exec(rawSchedule)) !== null) {
            const isBold = Boolean(slotMatch[1] && slotMatch[4]);
            slots.push({
                day: slotMatch[2],
                timeRange: slotMatch[3],
                isPrimary: isBold || slots.length === 0 // 太字指定または先頭を第1推奨
            });
        }

        if (slots.length > 0) {
            timings.push({
                channelId: config.id,
                channelName: config.displayName,
                slots
            });
        }
    }

    return timings;
}

// 01_Projects から仕掛かり案件（ready, in-production）を収集
function scanActiveProjects(vaultPath) {
    const projectsDir = path.join(vaultPath, '01_Projects');
    if (!fs.existsSync(projectsDir)) return [];

    const now = Date.now();
    const files = getAllMarkdownFiles(projectsDir);
    const projects = [];

    files.forEach(file => {
        // 補助ファイル（metadata, prompter, shorts_script, x_thread）は単体案件としてカウントせず script.md 側で扱う
        const base = file.name.toLowerCase();
        if (['metadata.md', 'prompter.md', 'shorts_script.md', 'x_thread.md'].includes(base)) {
            return;
        }

        try {
            const content = fs.readFileSync(file.fullPath, 'utf8');
            const { title, status, statusSince, channel } = parseMarkdownBasic(content);

            if (status && ['ready', 'in-production'].includes(status.toLowerCase())) {
                let ageDays = 0;
                if (statusSince) {
                    const d = new Date(statusSince);
                    if (!isNaN(d.getTime())) {
                        ageDays = Math.floor((now - d.getTime()) / (1000 * 60 * 60 * 24));
                    }
                } else {
                    ageDays = Math.floor((now - file.mtimeMs) / (1000 * 60 * 60 * 24));
                }

                // フォルダパスやfrontmatterからチャンネルを推定
                const relPath = path.relative(projectsDir, file.fullPath);
                let matchedConfig = CHANNEL_CONFIGS.find(cfg =>
                    (channel && cfg.channelTags.includes(channel)) ||
                    cfg.folderNames.some(fn => relPath.startsWith(fn))
                );

                if (!matchedConfig) {
                    matchedConfig = { id: 'other', displayName: 'その他' };
                }

                // 案件フォルダ内に prompter.md が存在するか判定
                const projectDir = path.dirname(file.fullPath);
                const hasPrompter = fs.existsSync(path.join(projectDir, 'prompter.md'));

                projects.push({
                    title: title || path.basename(file.name, '.md'),
                    fileName: file.name,
                    fullPath: file.fullPath,
                    relPath,
                    status: status.toLowerCase(),
                    ageDays,
                    channelId: matchedConfig.id,
                    channelName: matchedConfig.displayName,
                    hasPrompter
                });
            }
        } catch (e) {
            // パース失敗はスキップ
        }
    });

    return projects;
}

// メイン分析関数
function analyzeTodayShipTarget(vaultPath, targetDate = new Date()) {
    const todayDayName = DAY_NAMES[targetDate.getDay()];
    const latestReview = getLatestWeeklyReviewFile(vaultPath);

    let timings = [];
    if (latestReview) {
        try {
            const content = fs.readFileSync(latestReview.fullPath, 'utf8');
            timings = extractPostingTimings(content);
        } catch (e) {
            console.warn('[Analyzer Warning] 週次レビューパース失敗:', e.message);
        }
    }

    const activeProjects = scanActiveProjects(vaultPath);

    // 今日の推奨枠に合致するチャンネルを判定
    const todayTargets = [];
    const upcomingTargets = [];

    timings.forEach(timing => {
        const todaySlot = timing.slots.find(s => s.day === todayDayName);
        const channelProjects = activeProjects.filter(p => p.channelId === timing.channelId);

        // ready案件（最優先）と in-production案件に分類
        const readyProjects = channelProjects.filter(p => p.status === 'ready');
        const inProdProjects = channelProjects.filter(p => p.status === 'in-production');

        if (todaySlot) {
            todayTargets.push({
                channelId: timing.channelId,
                channelName: timing.channelName,
                slot: todaySlot,
                readyProjects,
                inProdProjects,
                hasReady: readyProjects.length > 0,
                hasInProd: inProdProjects.length > 0
            });
        } else {
            // 他の曜日の直近推奨枠
            const nextSlot = timing.slots[0]; // 第1推奨スロット
            upcomingTargets.push({
                channelId: timing.channelId,
                channelName: timing.channelName,
                slot: nextSlot,
                readyProjects,
                inProdProjects
            });
        }
    });

    // チャンネル未分類または推奨枠にないが ready の案件（例: 南信堂等）
    const otherActive = activeProjects.filter(p =>
        !timings.some(t => t.channelId === p.channelId)
    );

    return {
        todayDayName,
        targetDateStr: targetDate.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }),
        hasTargetToday: todayTargets.length > 0,
        todayTargets,
        upcomingTargets,
        otherActive,
        activeProjectsTotal: activeProjects.length
    };
}

module.exports = {
    analyzeTodayShipTarget,
    extractPostingTimings,
    scanActiveProjects,
    getLatestWeeklyReviewFile
};
