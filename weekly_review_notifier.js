/**
 * weekly_review_notifier.js
 * 
 * 日曜夜〜月曜早朝の週次レビュー（06_Weekly_Reviews）および週次企画ピッチ（NEXT_PITCH.md）の
 * 更新を検知し、Geminiによる要約・抜粋を添えてDiscord（COOチャンネル）へ自動通知するスクリプト。
 * 
 * ラズパイ上のcron等から定期実行されることを想定。
 * オプション:
 *   --force    : 前回通知状態を無視して強制通知
 *   --dry-run  : Discord送信を行わず、コンソールに結果を出力
 *   --no-pull  : Git pullをスキップ
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

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

// オプショナル依存の安全な読み込み
let matter = null;
try { matter = require('gray-matter'); } catch (_) {}

let GoogleGenAI = null;
try { GoogleGenAI = require('@google/genai').GoogleGenAI; } catch (_) {}

let Discord = null;
try { Discord = require('discord.js'); } catch (_) {}

// ==========================================
// ⚙️ 設定エリア
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.REVIEW_CHANNEL_ID || process.env.COO_CHANNEL_ID;
const VAULT_PATH = process.env.VAULT_PATH || '/home/tnuma/my-vault';
const STATE_FILE_PATH = path.join(__dirname, '.last_review_state.json');

// コマンドライン引数
const args = process.argv.slice(2);
const IS_FORCE = args.includes('--force');
const IS_DRY_RUN = args.includes('--dry-run');
const NO_PULL = args.includes('--no-pull');

// Gemini初期化
let ai = null;
if (GoogleGenAI && process.env.GEMINI_API_KEY) {
    try {
        ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } catch (e) {
        console.warn('[Gemini Init Warning]:', e.message);
    }
}

// ==========================================
// 🛠️ ユーティリティ関数
// ==========================================

// Markdown & Frontmatter 解析（gray-matter が無い場合もフォールバック）
function parseMarkdown(rawContent) {
    let title = null;
    let content = rawContent;

    if (matter) {
        try {
            const parsed = matter(rawContent);
            if (parsed.data && parsed.data.title) {
                title = parsed.data.title;
            }
            content = parsed.content;
        } catch (_) {}
    } else {
        const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        if (match) {
            const yamlStr = match[1];
            content = match[2];
            const titleMatch = yamlStr.match(/^title:\s*["']?([^"'\r\n]+)["']?/m);
            if (titleMatch) title = titleMatch[1].trim();
        }
    }

    // Frontmatterにtitleが無い場合、最初の # 見出しから抽出
    if (!title) {
        const h1Match = content.match(/^#\s+([^\r\n]+)/m);
        if (h1Match) {
            title = h1Match[1].trim();
        }
    }

    return { data: { title }, content };
}

// ファイルのSHA256ハッシュを計算
function getFileHash(content) {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

// 状態ファイルの読み込み
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            return JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('[State] 状態ファイルの読み込みに失敗しました。新規作成します:', e.message);
    }
    return {};
}

// 状態ファイルの保存
function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
        console.log('[State] 状態ファイルを更新しました:', STATE_FILE_PATH);
    } catch (e) {
        console.error('[State Error] 状態ファイルの保存に失敗:', e.message);
    }
}

// Vaultを最新に pull
function syncVault() {
    if (NO_PULL) {
        console.log('[Git] --no-pull が指定されているため、Git pullをスキップします。');
        return;
    }
    try {
        console.log(`[Git] Pulling latest changes in ${VAULT_PATH}...`);
        execSync(`git -C "${VAULT_PATH}" pull --rebase`, { stdio: 'pipe' });
        console.log('[Git] Pull completed successfully.');
    } catch (error) {
        console.warn('[Git Warning] pull 失敗（ローカルデータで継続します）:', error.message);
    }
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
            const stat = fs.statSync(fullPath);
            arrayOfFiles.push({
                name: file,
                relativePath: fullPath,
                fullPath,
                mtimeMs: stat.mtimeMs,
            });
        }
    });
    return arrayOfFiles;
}

// 06_Weekly_Reviews 配下で最新のMarkdownファイルを取得（サブディレクトリも再帰走査）
function getLatestWeeklyReviewFile(vaultPath) {
    const reviewsDir = path.join(vaultPath, '06_Weekly_Reviews');
    if (!fs.existsSync(reviewsDir)) {
        console.log(`[WeeklyReview] ディレクトリが存在しません: ${reviewsDir}`);
        return null;
    }

    const files = getAllMarkdownFiles(reviewsDir);
    if (files.length === 0) return null;

    // ファイル名（例: 2026-W37.md）または更新日時で降順ソート
    files.sort((a, b) => {
        if (a.name > b.name) return -1;
        if (a.name < b.name) return 1;
        return b.mtimeMs - a.mtimeMs;
    });

    return files[0];
}

// NEXT_PITCH.md のファイルパスを探す
function findNextPitchFile(vaultPath) {
    const candidatePaths = [
        path.join(vaultPath, '00_Inbox', 'NEXT_PITCH.md'),
        path.join(vaultPath, 'NEXT_PITCH.md')
    ];

    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            const stat = fs.statSync(p);
            return {
                name: path.basename(p),
                fullPath: p,
                mtimeMs: stat.mtimeMs
            };
        }
    }
    return null;
}

// ==========================================
// 🧠 Gemini / フォールバック要約生成
// ==========================================

async function callGemini(prompt) {
    if (!ai) return null;
    const candidateModels = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-2.0-flash'];
    for (const model of candidateModels) {
        try {
            const response = await ai.models.generateContent({
                model,
                contents: prompt,
            });
            if (response && response.text) {
                return response.text.trim();
            }
        } catch (e) {
            // 次のモデル候補を試行
        }
    }
    return null;
}

async function generateWeeklyReviewSummary(filename, content) {
    if (ai) {
        try {
            console.log(`[Gemini] 週次レビューの要約を生成中: ${filename}`);
            const prompt = `
あなたは知的生産および個人プロジェクトの運営参謀（COO）です。
以下の週次レビュー（Weekly Review）のMarkdown内容を読み、Discord通知用のハイライト要約を作成してください。

【要件】
- 400〜600文字程度で簡潔にまとめること
- 以下の3項目を箇条書きで整理すること:
  1. 🚀 今週の成果・Ship実績 (1〜3点)
  2. 🔍 主な振り返り・気づき・ボトルネック
  3. 🎯 次週の注力フォーカス
- 箇条書き記号は「•」を使用し、Markdown装飾（**太字**）を適度に使って視認性を高めること
- コードブロック記号や不要な前置き・後置き挨拶は含めないこと

【週次レビュー本文】
${content.slice(0, 8000)}
`;
            const text = await callGemini(prompt);
            if (text) return text;
        } catch (e) {
            console.warn('[Gemini Error - Weekly Review]:', e.message);
        }
    }

    return createFallbackExcerpt(content);
}

async function generateNextPitchSummary(filename, content) {
    if (ai) {
        try {
            console.log(`[Gemini] NEXT_PITCH の要約を生成中`);
            const prompt = `
あなたは知的生産およびコンテンツ企画の運営参謀（COO）です。
以下の企画提案メモ（NEXT_PITCH.md）を読み、Discord通知用のハイライト要約を作成してください。

【要件】
- 300〜500文字程度で簡潔にまとめること
- 以下の項目を箇条書きで整理すること:
  • 💡 企画タイトル / コアコンセプト
  • 🎯 ターゲット / 解決する課題やフック
  • 🛠️ 制作・検証のネクストアクション
- コードブロック記号や不要な前置き・後置き挨拶は含めないこと

【NEXT_PITCH本文】
${content.slice(0, 8000)}
`;
            const text = await callGemini(prompt);
            if (text) return text;
        } catch (e) {
            console.warn('[Gemini Error - NEXT_PITCH]:', e.message);
        }
    }

    return createFallbackExcerpt(content);
}

function createFallbackExcerpt(content) {
    const lines = content.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('---'));

    const excerptLines = [];
    let count = 0;
    for (const line of lines) {
        if (line.startsWith('#')) {
            excerptLines.push(`**${line.replace(/^#+\s*/, '')}**`);
        } else {
            excerptLines.push(line);
        }
        count += line.length;
        if (count > 500) break;
    }
    return excerptLines.join('\n\n').slice(0, 800) || '（本文が空または短いメモです）';
}

// ==========================================
// 🚀 メイン処理
// ==========================================

async function main() {
    console.log('==================================================');
    console.log(`[Weekly Review Notifier] 起動: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
    console.log(`[Vault Path]: ${VAULT_PATH}`);
    console.log('==================================================');

    // 1. Vaultを最新化
    syncVault();

    // 2. 状態ファイル読み込み
    const state = loadState();
    const updates = [];

    // 3. 週次レビュー（06_Weekly_Reviews）の検査
    const latestReview = getLatestWeeklyReviewFile(VAULT_PATH);
    if (latestReview) {
        try {
            const rawContent = fs.readFileSync(latestReview.fullPath, 'utf8');
            const hash = getFileHash(rawContent);
            const prevState = state.weekly_review || {};

            const isChanged = IS_FORCE || (prevState.file !== latestReview.name) || (prevState.hash !== hash);

            if (isChanged) {
                console.log(`✨ [WeeklyReview] 更新を検知: ${latestReview.name}`);
                const { data: frontmatter, content } = parseMarkdown(rawContent);
                const title = frontmatter.title || path.basename(latestReview.name, '.md');
                const summary = await generateWeeklyReviewSummary(latestReview.name, content || rawContent);

                updates.push({
                    type: 'weekly_review',
                    file: latestReview.name,
                    title: `📅 週次レビュー更新: ${title}`,
                    summary,
                    hash,
                    color: 0x3498db, // ブルー
                    footer: `06_Weekly_Reviews/${latestReview.name}`
                });
            } else {
                console.log(`☕ [WeeklyReview] 変更なし (${latestReview.name})`);
            }
        } catch (e) {
            console.error(`[WeeklyReview Error]:`, e.message);
        }
    } else {
        console.log('[WeeklyReview] 対象ファイルが見つかりませんでした。');
    }

    // 4. NEXT_PITCH.md の検査
    const nextPitch = findNextPitchFile(VAULT_PATH);
    if (nextPitch) {
        try {
            const rawContent = fs.readFileSync(nextPitch.fullPath, 'utf8');
            const hash = getFileHash(rawContent);
            const prevState = state.next_pitch || {};

            const isChanged = IS_FORCE || (prevState.hash !== hash);

            if (isChanged) {
                console.log(`✨ [NEXT_PITCH] 更新を検知: ${nextPitch.name}`);
                const { data: frontmatter, content } = parseMarkdown(rawContent);
                const title = frontmatter.title || '週次企画ピッチ案';
                const summary = await generateNextPitchSummary(nextPitch.name, content || rawContent);

                updates.push({
                    type: 'next_pitch',
                    file: nextPitch.name,
                    title: `💡 企画ピッチ更新: ${title}`,
                    summary,
                    hash,
                    color: 0x2ecc71, // グリーン
                    footer: path.relative(VAULT_PATH, nextPitch.fullPath)
                });
            } else {
                console.log(`☕ [NEXT_PITCH] 変更なし (${nextPitch.name})`);
            }
        } catch (e) {
            console.error(`[NEXT_PITCH Error]:`, e.message);
        }
    } else {
        console.log('[NEXT_PITCH] 対象ファイルが見つかりませんでした。');
    }

    // 5. 更新がなければ終了
    if (updates.length === 0) {
        console.log('✅ 通知対象の更新はありませんでした。終了します。');
        process.exit(0);
    }

    // 6. Discord送信またはDry-Run出力
    if (IS_DRY_RUN) {
        console.log('\n--- 🧪 DRY RUN 出力 ---');
        for (const u of updates) {
            console.log(`\n【${u.title}】`);
            console.log(`Footer: ${u.footer}`);
            console.log('要約内容:');
            console.log(u.summary);
            console.log('---------------------------');
        }
        console.log('🧪 DRY RUN 完了（Discord送信は行われませんでした）');
        process.exit(0);
    }

    if (!Discord) {
        console.error('❌ discord.js がインストールされていません。');
        process.exit(1);
    }

    if (!TOKEN || !CHANNEL_ID) {
        console.error('❌ DISCORD_TOKEN または COO_CHANNEL_ID が設定されていません。');
        process.exit(1);
    }

    console.log(`📡 Discordへ ${updates.length} 件の更新を送信します...`);
    const { Client, GatewayIntentBits, EmbedBuilder } = Discord;
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    const eventName = client.on ? 'clientReady' : 'ready';
    client.once(eventName, async () => {
        try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            if (!channel) {
                console.error(`❌ 指定されたチャンネル (${CHANNEL_ID}) が見つかりません。`);
                process.exit(1);
            }

            for (const item of updates) {
                const safeSummary = item.summary.length > 3800 ? item.summary.slice(0, 3800) + '...\n*(以降省略)*' : item.summary;

                const embed = new EmbedBuilder()
                    .setTitle(item.title)
                    .setDescription(safeSummary)
                    .setColor(item.color)
                    .setFooter({ text: `${item.footer} • Obsidian Auto-Sync` })
                    .setTimestamp();

                await channel.send({ embeds: [embed] });
                console.log(`📨 送信完了: ${item.title}`);

                if (item.type === 'weekly_review') {
                    state.weekly_review = {
                        file: item.file,
                        hash: item.hash,
                        notified_at: new Date().toISOString()
                    };
                } else if (item.type === 'next_pitch') {
                    state.next_pitch = {
                        file: item.file,
                        hash: item.hash,
                        notified_at: new Date().toISOString()
                    };
                }
            }

            saveState(state);
            console.log('🎉 すべての通知処理が正常に完了しました。');

        } catch (err) {
            console.error('❌ Discord送信中にエラーが発生しました:', err);
        } finally {
            client.destroy();
            process.exit(0);
        }
    });

    await client.login(TOKEN);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
