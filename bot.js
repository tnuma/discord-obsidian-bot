require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
 
const { fetchProductResearch, analyzeThoughtMemo } = require('./researcher');
const { scanActiveProjects } = require('./ship_target_analyzer');
const { VoiceTranscriber } = require('./voiceTranscriber');
const matter = require('gray-matter');

// ==========================================
// ⚙️ 設定エリア
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN;
const MEMO_CHANNEL_ID = process.env.MEMO_CHANNEL_ID;
const RESEARCH_CHANNEL_ID = process.env.RESEARCH_CHANNEL_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const TRANSCRIPT_CHANNEL_ID = process.env.TRANSCRIPT_CHANNEL_ID;
const SYNC_THOUGHT_TO_OBSIDIAN = process.env.SYNC_THOUGHT_TO_OBSIDIAN === 'true';
const PROMPTER_PORT = process.env.PROMPTER_PORT || '3333';

const VAULT_ROOT_DIR = process.env.VAULT_PATH || '/home/tnuma/my-vault';
const MEMO_SAVE_DIR = path.join(VAULT_ROOT_DIR, '00_Inbox');
const BREWING_SAVE_DIR = path.join(MEMO_SAVE_DIR, 'brewing');
const RESEARCH_SAVE_DIR = path.join(VAULT_ROOT_DIR, '00_Inbox/Nanshindo');
// ==========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
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

function injectVoiceMetadata(markdown) {
    if (!markdown) return markdown;
    try {
        const parsed = matter(markdown);
        if (!parsed.data) parsed.data = {};

        // tags の処理（重複なく voice-memo を先頭に追加）
        if (!parsed.data.tags) {
            parsed.data.tags = ['voice-memo'];
        } else if (Array.isArray(parsed.data.tags)) {
            if (!parsed.data.tags.includes('voice-memo')) {
                parsed.data.tags.unshift('voice-memo');
            }
        } else if (typeof parsed.data.tags === 'string') {
            parsed.data.tags = ['voice-memo', parsed.data.tags];
        }

        // source の処理
        if (!parsed.data.source) {
            parsed.data.source = 'voice-input';
        }

        return matter.stringify(parsed.content, parsed.data);
    } catch (e) {
        console.error('injectVoiceMetadata error:', e);
        return markdown;
    }
}

// ----------------------------------------------------
// ☕ 発酵完了（status: brewed）メモの自動昇華処理
// ----------------------------------------------------
async function processBrewedNotes(triggerChannel = null) {
    try {
        await fs.mkdir(BREWING_SAVE_DIR, { recursive: true });
        const files = await fs.readdir(BREWING_SAVE_DIR);
        const mdFiles = files.filter(f => f.endsWith('.md'));

        let processedCount = 0;

        for (const file of mdFiles) {
            const filepath = path.join(BREWING_SAVE_DIR, file);
            const content = await fs.readFile(filepath, 'utf8');

            // status: brewed （または ready, done）を検知
            const statusMatch = content.match(/^status:\s*["']?([^"'\r\n]+)["']?/m);
            const status = statusMatch ? statusMatch[1].trim().toLowerCase() : '';

            if (status === 'brewed' || status === 'ready' || status === 'done') {
                console.log(`☕ 発酵完了（status: ${status}）を検知: ${file}`);
                processedCount++;

                const cleanName = path.basename(file, '.md');
                const inputForAsset = `【元メモ・生ログおよび追記内容】:\n${content}`;

                // 概念リンクを収集して thought-asset として再生成
                const existingConcepts = await getExistingConceptsFromVault();
                let newMarkdown = await analyzeThoughtMemo(inputForAsset, existingConcepts);

                // 元のメモに voice-memo があれば引き継ぐ
                if (content.includes('voice-memo')) {
                    newMarkdown = injectVoiceMetadata(newMarkdown);
                }

                const newTitle = extractFilenameFromMarkdown(newMarkdown, cleanName);
                const destPath = path.join(MEMO_SAVE_DIR, `${newTitle}.md`);

                // 00_Inbox 直下に保存
                await fs.writeFile(destPath, newMarkdown, 'utf8');
                console.log(`📝 正規構造化メモとして保存: ${destPath}`);

                // 元の brewing ファイルを削除
                await fs.unlink(filepath);
                console.log(`🗑️ 未発酵メモを削除: ${filepath}`);

                // Git 同期
                await syncToGit(`Brew memo: ${newTitle} (sublimated from ${file})`);

                // Discord 通知
                const targetChannel = triggerChannel || (TRANSCRIPT_CHANNEL_ID ? await client.channels.fetch(TRANSCRIPT_CHANNEL_ID).catch(() => null) : null);
                if (targetChannel) {
                    await targetChannel.send(`☕ **${newTitle}** が発酵完了（\`status: brewed\`）し、正規の構造化メモ（00_Inbox）に昇華されました！`);
                }
            }
        }

        return processedCount;
    } catch (err) {
        console.error('[processBrewedNotes Error]:', err);
        return 0;
    }
}

// ----------------------------------------------------
// 🎙️ 音声思考ログ・文字起こしモジュールの初期化
// ----------------------------------------------------
const voiceTranscriber = new VoiceTranscriber(client, {
    voiceChannelId: VOICE_CHANNEL_ID,
    outputChannelId: TRANSCRIPT_CHANNEL_ID,
    onTranscribeComplete: async (formattedText, meta) => {
        console.log('🧠 音声思考生ログをObsidianに自動連携・構造化して保存します...');
        taskQueue.push(async () => {
            try {
                const targetChannelId = TRANSCRIPT_CHANNEL_ID || VOICE_CHANNEL_ID;
                const channel = await client.channels.fetch(targetChannelId).catch(() => null);

                // 1. Vaultから既存の概念リンクを自動収集
                const existingConcepts = await getExistingConceptsFromVault();
                console.log(`🔗 参照概念数: ${existingConcepts.length} 件`);

                // 2. 自動判別とMarkdown生成
                let markdownContent = await analyzeThoughtMemo(formattedText, existingConcepts);
                markdownContent = injectVoiceMetadata(markdownContent);
                const cleanTitle = extractFilenameFromMarkdown(markdownContent, `音声思考メモ_${meta.userName}`);

                // 3. Vaultへ保存（未発酵なら brewing フォルダ、完成形なら Inbox 直下）
                const isSeed = /type:\s*thought-seed/.test(markdownContent);
                const targetSaveDir = isSeed ? BREWING_SAVE_DIR : MEMO_SAVE_DIR;
                await fs.mkdir(targetSaveDir, { recursive: true });
                const filepath = path.join(targetSaveDir, `${cleanTitle}.md`);
                await fs.writeFile(filepath, markdownContent, 'utf8');
                console.log(`📝 音声思考ログのVault保存完了: ${filepath}`);

                // 4. Git同期
                await syncToGit(isSeed ? `Add thought-seed (brewing): ${cleanTitle}` : `Add voice memo: ${cleanTitle}`);

                // 5. Discordへ完了通知
                if (channel) {
                    const notifyMsg = isSeed
                        ? `🌱 **${cleanTitle}** を「未発酵メモ（00_Inbox/brewing）」として保存しました！\n💡 Obsidianで発酵スペースに追記し、\`status: brewed\` にすると正規メモに自動昇華されます。`
                        : `💡 **${cleanTitle}** を分類・構造化してObsidian（00_Inbox）に保存しました！`;
                    await channel.send(notifyMsg);
                }
            } catch (err) {
                console.error('音声思考ログのObsidian保存エラー:', err);
                const targetChannelId = TRANSCRIPT_CHANNEL_ID || VOICE_CHANNEL_ID;
                const channel = await client.channels.fetch(targetChannelId).catch(() => null);
                if (channel) {
                    await channel.send('⚠️ Obsidianへの構造化・保存処理中にエラーが発生しました。詳細はログをご確認ください。').catch(() => {});
                }
            }
        });
        processQueue();
    },
});

client.once('clientReady', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log('🚀 Nanshindo Multi-Triage Bot is online.');
    voiceTranscriber.init();

    // 1分ごとに brewing フォルダ内の status: brewed をチェック
    setInterval(() => {
        processBrewedNotes().catch(() => {});
    }, 60 * 1000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const trimmed = (message.content || '').trim().toLowerCase();

    // ----------------------------------------------------
    // 🏓 稼働確認・ステータスコマンド (!ping / !status)
    // ----------------------------------------------------
    if (trimmed === '!ping' || trimmed === '!status') {
        const vcStatus = voiceTranscriber.connection ? `🟢 接続中 (${voiceTranscriber.activeUserId ? '録音中' : '待機中'})` : '⚪ 未接続';
        const vcConfig = VOICE_CHANNEL_ID ? `<#${VOICE_CHANNEL_ID}>` : '未設定 (手動 `!join` で利用可能)';
        const outConfig = TRANSCRIPT_CHANNEL_ID ? `<#${TRANSCRIPT_CHANNEL_ID}>` : 'VC内テキストチャット';
        return message.reply(`🏓 **Pong! Botは正常に稼働しています。**\n• 対象ボイスチャンネル: ${vcConfig}\n• 投稿先テキストチャンネル: ${outConfig}\n• ボイス接続状態: ${vcStatus}\n\n💡 VCに入ると自動で録音開始、または \`!join\` で今いるVCに呼べます。`);
    }

    // ----------------------------------------------------
    // 🎙️ ボイス文字起こし手動操作 (!join / !leave)
    // ----------------------------------------------------
    if (trimmed === '!join') {
        const memberVoiceChannel = message.member?.voice?.channel;
        if (!memberVoiceChannel) {
            return message.reply('⚠️ まずあなたがボイスチャンネルに接続してください。');
        }
        await voiceTranscriber.startSession(memberVoiceChannel, message.author.id);
        return message.reply(`🎙️ **${memberVoiceChannel.name}** に参加しました。思考を話し終えてVCを退出（または \`!leave\`）すると自動で文字起こし・整形されます。`);
    }

    if (trimmed === '!leave') {
        if (voiceTranscriber.connection) {
            await voiceTranscriber.endSessionAndTranscribe(message.member?.displayName || message.author.username);
            return message.reply('🎙️ 録音を終了し、思考ログの文字起こし・整形を開始します...');
        } else {
            return message.reply('⚠️ 現在ボイスチャンネルに接続していません。');
        }
    }

    // ----------------------------------------------------
    // ☕ 発酵メモ手動昇華・一覧コマンド (!brew / !brewing / !seeds)
    // ----------------------------------------------------
    if (trimmed === '!brew' || trimmed === '!brewed') {
        const count = await processBrewedNotes(message.channel);
        if (count === 0) {
            return message.reply('ℹ️ 現在 `status: brewed` になっているメモはありませんでした。\nObsidianで未発酵メモ（`00_Inbox/brewing/`）のフロントマターを `status: brewed` に変更してから再度お試しください。');
        } else {
            return message.reply(`☕ ${count} 件のメモを発酵（brewed）し、正規構造化メモ（00_Inbox）へ昇華しました！`);
        }
    }

    if (trimmed === '!brewing' || trimmed === '!seeds') {
        try {
            await fs.mkdir(BREWING_SAVE_DIR, { recursive: true });
            const files = await fs.readdir(BREWING_SAVE_DIR);
            const mdFiles = files.filter(f => f.endsWith('.md'));
            if (mdFiles.length === 0) {
                return message.reply('🌱 現在発酵中（00_Inbox/brewing）のメモはありません。');
            }
            const listText = mdFiles.map((f, i) => `${i + 1}. **${f.replace('.md', '')}**`).join('\n');
            return message.reply(`🌱 **現在発酵中（00_Inbox/brewing）のメモ一覧 (${mdFiles.length}件)**:\n${listText}\n\n💡 Obsidianで発酵スペースに追記し、\`status: brewed\` に書き換えると自動で正規メモに昇華されます。`);
        } catch (e) {
            return message.reply('⚠️ brewingフォルダの取得に失敗しました。');
        }
    }

    // ----------------------------------------------------
    // 🎬 プロンプター起動コマンド (!prompter / /prompter / プロンプター)
    // ----------------------------------------------------
    if (trimmed === '!prompter' || trimmed === '/prompter' || trimmed === 'プロンプター' || trimmed === '!teleprompter') {
        try {
            const activeProjects = scanActiveProjects(VAULT_ROOT_DIR);
            // prompter.md が存在する案件のみに絞り込み
            const prompterProjects = activeProjects.filter(p => p.hasPrompter);
            const readyList = prompterProjects.filter(p => p.status === 'ready');
            const inProdList = prompterProjects.filter(p => p.status === 'in-production');

            const baseUrl = `http://pi4.local:${PROMPTER_PORT}`;
            const fields = [];

            if (readyList.length > 0) {
                const links = readyList.map(p => {
                    const projectKey = p.relPath.replace(/\/[^/]+$/, '');
                    return `• **[${p.title}](${baseUrl}/p/${encodeURIComponent(projectKey)})** (${p.channelName} / ready ${p.ageDays}日)`;
                }).join('\n');
                fields.push({ name: '🎯 収録待ちの台本 (ready)', value: links });
            }

            if (inProdList.length > 0) {
                const links = inProdList.slice(0, 3).map(p => {
                    const projectKey = p.relPath.replace(/\/[^/]+$/, '');
                    return `• **[${p.title}](${baseUrl}/p/${encodeURIComponent(projectKey)})** (${p.channelName} / 制作中 ${p.ageDays}日)`;
                }).join('\n');
                fields.push({ name: '⚡ 制作進行中の案件 (in-production)', value: links });
            }

            const embed = new EmbedBuilder()
                .setTitle('🎬 Web Teleprompter')
                .setDescription(`タップするとスマホのブラウザで全画面プロンプターが起動します。\n一覧画面: [**案件リストを開く**](${baseUrl})`)
                .setColor(readyList.length > 0 ? 0x10b981 : 0x3498db)
                .setFooter({ text: 'ステップ送り・呼吸オート・目線ガイド対応' })
                .setTimestamp();

            if (fields.length > 0) {
                embed.addFields(fields);
            } else {
                embed.addFields({ name: 'お知らせ', value: '現在 `prompter.md`（専用台本）が用意された案件はありません。\n案件フォルダ内に `prompter.md` を作成すると自動表示されます。' });
            }

            await message.reply({ embeds: [embed] });
            return;
        } catch (err) {
            console.error('Prompter command error:', err);
            await message.reply('⚠️ プロンプターURLの生成中にエラーが発生しました。');
            return;
        }
    }

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
 
                // 3. Vaultへ保存（未発酵なら brewing フォルダ、完成形なら Inbox 直下）
                const isSeed = /type:\s*thought-seed/.test(markdownContent);
                const targetSaveDir = isSeed ? BREWING_SAVE_DIR : MEMO_SAVE_DIR;
                await fs.mkdir(targetSaveDir, { recursive: true });
                const filepath = path.join(targetSaveDir, `${cleanTitle}.md`);
                await fs.writeFile(filepath, markdownContent, 'utf8');
                console.log(`📝 保存完了: ${filepath}`);

                // 4. Git同期
                await syncToGit(isSeed ? `Add thought-seed (brewing): ${cleanTitle}` : `Add memo: ${cleanTitle}`);

                if (waitReaction) {
                    try { await waitReaction.users.remove(client.user.id); } catch (_) {}
                }
                await message.react('✅');
                const replyMsg = isSeed
                    ? `🌱 **${cleanTitle}** を「未発酵メモ（00_Inbox/brewing）」として保存しました！\n💡 Obsidianで発酵スペースに追記し、\`status: brewed\` にすると正規メモに自動昇華されます。`
                    : `💡 **${cleanTitle}** を分類・構造化してObsidian（00_Inbox）に保存しました！`;
                await message.reply(replyMsg);
 
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

