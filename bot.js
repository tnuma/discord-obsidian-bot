
/






















Bot · JS
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
 
const { fetchProductResearch, analyzeThoughtMemo } = require('./researcher');
 
// ==========================================
// ⚙️ 設定エリア
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const MEMO_CHANNEL_ID = process.env.MEMO_CHANNEL_ID;
const RESEARCH_CHANNEL_ID = process.env.RESEARCH_CHANNEL_ID;
 
const VAULT_ROOT_DIR = '/home/tnuma/my-vault';
const MEMO_SAVE_DIR = path.join(VAULT_ROOT_DIR, '00_Inbox');
const RESEARCH_SAVE_DIR = path.join(VAULT_ROOT_DIR, '00_Inbox/Nanshindo');
// ==========================================
 
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});
 
function sanitizeFilename(name) {
    return name
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[._]+|[._]+$/g, '')
        .substring(0, 80);
}
 
function extractFilenameFromMarkdown(markdown, fallbackName) {
    const titleMatch = markdown.match(/^title:\s*["']?([^"'\r\n]+)["']?/m);
    if (titleMatch && titleMatch[1].trim()) {
        return sanitizeFilename(titleMatch[1].trim());
    }
 
    const headingMatch = markdown.match(/^#\s+([^\r\n]+)/m);
    if (headingMatch && headingMatch[1].trim()) {
        return sanitizeFilename(headingMatch[1].trim());
    }
 
    return sanitizeFilename(fallbackName);
}
 
async function extractTextFromMessage(message) {
    let text = message.content ? message.content.trim() : '';
 
    const textAttachment = message.attachments.find(att =>
        att.name.endsWith('.txt') ||
        att.name.endsWith('.md') ||
        att.contentType?.startsWith('text/')
    );
 
    if (textAttachment) {
        try {
            const res = await fetch(textAttachment.url);
            const fileContent = await res.text();
            text = text ? `${text}\n\n${fileContent.trim()}` : fileContent.trim();
        } catch (err) {
            console.error('添付ファイル取得エラー:', err);
        }
    }
 
    return text.trim();
}
 
// Vault全体のMarkdownから [[概念名]] を重複なく収集
async function getExistingConceptsFromVault() {
    const concepts = new Set();
    const linkRegex = /\[\[(.*?)\]\]/g;
 
    async function scanDir(dir) {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    await scanDir(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.md')) {
                    const content = await fs.readFile(fullPath, 'utf8');
                    let match;
                    while ((match = linkRegex.exec(content)) !== null) {
                        const cleanLink = match[1].split('|')[0].split('#')[0].trim();
                        if (cleanLink && cleanLink.length < 30) {
                            concepts.add(cleanLink);
                        }
                    }
                }
            }
        } catch (e) {
            console.error('リンク走査エラー:', e.message);
        }
    }
 
    await scanDir(VAULT_ROOT_DIR);
    return Array.from(concepts);
}
 
async function syncToGit(commitMessage) {
    try {
        const safeMsg = commitMessage.replace(/"/g, '\\"');
        const cmd = `cd "${VAULT_ROOT_DIR}" && git add . && git commit -m "${safeMsg}" && git pull --rebase origin main && git push origin main`;
        const { stdout } = await execPromise(cmd);
        console.log(`[Git Sync Success]:\n${stdout}`);
        return true;
    } catch (error) {
        console.error(`[Git Sync Error]:`, error.message);
        return false;
    }
}
 
// 順番待ちキュー
const taskQueue = [];
let isProcessing = false;
 
async function processQueue() {
    if (isProcessing || taskQueue.length === 0) return;
    isProcessing = true;
 
    const task = taskQueue.shift();
    try {
        await task();
    } catch (err) {
        console.error('Task error:', err);
    } finally {
        isProcessing = false;
        processQueue();
    }
}
 
client.once('clientReady', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log('🚀 Nanshindo Multi-Triage Bot is online.');
});
 
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
 
    // ----------------------------------------------------
    // ① 文房具リサーチ
    // ----------------------------------------------------
    if (message.channelId === RESEARCH_CHANNEL_ID) {
        const inputContent = await extractTextFromMessage(message);
        if (!inputContent) return;
 
        let waitReaction = null;
        try { waitReaction = await message.react('⏳'); } catch (_) {}
 
        taskQueue.push(async () => {
            console.log(`🔍 リサーチ開始: ${inputContent.slice(0, 30)}...`);
            try {
                const markdownContent = await fetchProductResearch(inputContent);
                const cleanTitle = extractFilenameFromMarkdown(markdownContent, inputContent.slice(0, 20));
 
                await fs.mkdir(RESEARCH_SAVE_DIR, { recursive: true });
                const filepath = path.join(RESEARCH_SAVE_DIR, `${cleanTitle}.md`);
                await fs.writeFile(filepath, markdownContent, 'utf8');
                console.log(`📁 保存完了: ${filepath}`);
 
                await syncToGit(`Add research: ${cleanTitle}`);
 
                if (waitReaction) {
                    try { await waitReaction.users.remove(client.user.id); } catch (_) {}
                }
                await message.react('✅');
                await message.reply(`📝 **${cleanTitle}** のプレプロダクションを作成しました！`);
 
            } catch (error) {
                console.error(`Research error:`, error);
                if (waitReaction) {
                    try { await waitReaction.users.remove(client.user.id); } catch (_) {}
                }
                await message.react('❌');
                await message.reply('⚠️ 処理中にエラーが発生しました。詳細はサーバーのログを確認してください。');
            }
        });
 
        processQueue();
        return;
    }
 
    // ----------------------------------------------------
    // ② メモ自動判別（思考 / 動画研究 / タスク）
    // ----------------------------------------------------
    if (message.channelId === MEMO_CHANNEL_ID) {
        const inputContent = await extractTextFromMessage(message);
        if (!inputContent) return;
 
        let waitReaction = null;
        try { waitReaction = await message.react('⏳'); } catch (_) {}
 
        taskQueue.push(async () => {
            console.log(`🧠 メモのトリアージ＆処理開始...`);
            try {
                // 1. Vaultから既存の概念リンクを自動収集
                const existingConcepts = await getExistingConceptsFromVault();
                console.log(`🔗 参照概念数: ${existingConcepts.length} 件`);
 
                // 2. 自動判別とMarkdown生成
                const markdownContent = await analyzeThoughtMemo(inputContent, existingConcepts);
                const cleanTitle = extractFilenameFromMarkdown(markdownContent, 'メモ');
 
                // 3. Vaultへ保存
                await fs.mkdir(MEMO_SAVE_DIR, { recursive: true });
                const filepath = path.join(MEMO_SAVE_DIR, `${cleanTitle}.md`);
                await fs.writeFile(filepath, markdownContent, 'utf8');
                console.log(`📝 保存完了: ${filepath}`);
 
                // 4. Git同期
                await syncToGit(`Add memo: ${cleanTitle}`);
 
                if (waitReaction) {
                    try { await waitReaction.users.remove(client.user.id); } catch (_) {}
                }
                await message.react('✅');
                await message.reply(`💡 **${cleanTitle}** を分類・構造化してObsidianに保存しました！`);
 
            } catch (error) {
                console.error(`Memo error:`, error);
                if (waitReaction) {
                    try { await waitReaction.users.remove(client.user.id); } catch (_) {}
                }
                await message.react('❌');
                await message.reply('⚠️ 処理中にエラーが発生しました。詳細はサーバーのログを確認してください。');
            }
        });
 
        processQueue();
    }
});
 
client.login(TOKEN);

