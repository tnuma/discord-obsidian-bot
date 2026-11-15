const fs = require('fs').promises;
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.LINK_GEMINI_MODEL || 'gemini-3.7-flash';

// スレッドIDごとの対話セッションを保持
// Map<threadId, { mode, url, pageTitle, images: [{ buffer, ext, mimeType }], history: [], turnCount: number, createdAt: number }>
const activeSessions = new Map();

// 古いセッションを自動掃除（2時間以上経過）
setInterval(() => {
    const now = Date.now();
    for (const [threadId, session] of activeSessions.entries()) {
        if (now - session.createdAt > 2 * 60 * 60 * 1000) {
            activeSessions.delete(threadId);
        }
    }
}, 15 * 60 * 1000);

function hasSession(threadId) {
    return activeSessions.has(threadId);
}

function getSession(threadId) {
    return activeSessions.get(threadId);
}

function deleteSession(threadId) {
    activeSessions.delete(threadId);
}

/**
 * メッセージから最初のURLを抽出
 */
function extractUrl(text) {
    if (!text) return null;
    const match = text.match(/https?:\/\/[^\s<>()]+/i);
    return match ? match[0] : null;
}

/**
 * URLからOGP/HTMLタイトルを軽量取得（失敗してもnullを返す）
 */
async function fetchPageTitle(url) {
    if (!url) return null;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; DiscordObsidianBot/1.0)',
                'Accept-Language': 'ja,en;q=0.9',
            },
        });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) return null;

        const html = await res.text();
        const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        if (ogTitleMatch && ogTitleMatch[1]) {
            return decodeHtmlEntities(ogTitleMatch[1].trim());
        }

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
            return decodeHtmlEntities(titleMatch[1].trim());
        }
        return null;
    } catch (_) {
        return null;
    }
}

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ');
}

/**
 * Discordメッセージの添付画像をBufferとしてダウンロード
 */
async function downloadImageAttachments(message) {
    const images = [];
    for (const att of message.attachments.values()) {
        const isImage = att.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(att.name || '');
        if (!isImage) continue;

        try {
            const res = await fetch(att.url);
            if (!res.ok) continue;
            const arrayBuffer = await res.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const extMatch = (att.name || '').match(/\.(png|jpe?g|webp|gif)$/i);
            const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
            const mimeType = att.contentType || `image/${ext === 'jpg' ? 'jpeg' : ext}`;
            images.push({ buffer, ext, mimeType, originalName: att.name });
        } catch (err) {
            console.error('画像ダウンロードエラー:', err);
        }
    }
    return images;
}

/**
 * 保存/キャンセル用のDiscordボタン行を生成
 */
function buildActionRow(threadId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`link_save_${threadId}`)
            .setLabel('この内容で保存する')
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId(`link_cancel_${threadId}`)
            .setLabel('キャンセル')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('❌')
    );
}

/**
 * Geminiを使って対話の深掘り質問を生成する
 * ※ nsfw モードでは Safety Filter 回避のため画像バイナリは送らずテキストのみで対話する
 */
async function generateFollowupQuestion(session) {
    const isNsfw = session.mode === 'nsfw';
    const historyText = session.history
        .map(h => `${h.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${h.text}`)
        .join('\n');

    const systemInstruction = isNsfw
        ? `あなたはユーザーの創作・AI画像生成のインスピレーション言語化パートナーです。
ユーザーは「なぜその表現・構図・シチュエーションが刺さったのか」を後から参照できる資産として記録しようとしています。
以下の情報を踏まえ、ユーザーの「刺さった核心（構図・視線・表情・シチュエーション・心理的関係性・フェチ要素など）」を引き出すための**簡潔な質問を1つ（多くて2つ）**だけ投げかけてください。
※説教や評価は一切不要。親しみやすく簡潔に（3〜4行以内）。`
        : `あなたはコンテンツ制作（動画・SNS・デザイン・構成）の分析パートナーです。
ユーザーは参考にしたコンテンツ（動画・記事・UI・サムネ等）の「なぜそれが刺さったのか」を言語化して自分の制作に活かそうとしています。
以下の情報を踏まえ、表現の仕掛け・フック・心理トリガーや「自分のコンテンツへの転用アイデア」を引き出すための**簡潔な質問を1つ（多くて2つ）**だけ投げかけてください。
※画像が添付されている場合は、画像内のレイアウトや要素にも軽く触れながら質問してください。簡潔に（3〜4行以内）。`;

    const contextLines = [
        `URL: ${session.url || 'なし（画像/テキストのみ）'}`,
        session.pageTitle ? `ページタイトル: ${session.pageTitle}` : null,
        `添付画像数: ${session.images.length}枚`,
        `現在の対話回数: ${session.turnCount}回目`,
        `\n--- これまでのやりとり ---\n${historyText || '（まだコメントなし）'}`,
    ].filter(Boolean).join('\n');

    const promptText = `${systemInstruction}\n\n${contextLines}`;

    try {
        const contents = [{ text: promptText }];
        // contentモードかつ画像がある場合のみVision入力に含める
        if (!isNsfw && session.images.length > 0 && session.turnCount === 0) {
            const firstImg = session.images[0];
            contents.push({
                inlineData: {
                    data: firstImg.buffer.toString('base64'),
                    mimeType: firstImg.mimeType,
                },
            });
        }

        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents,
        });
        const text = response.text?.trim();
        if (text) return text;
    } catch (err) {
        console.warn('Gemini対話生成フォールバック:', err.message);
    }

    // フォールバック質問
    if (isNsfw) {
        return '受け取りました！この作品の**どこが一番刺さりましたか？**（例：構図・見下ろし/見上げの視点・表情・シチュエーション・フェチ要素など）';
    }
    return '受け取りました！このコンテンツの**どこが一番「いい！」と思いましたか？**（例：冒頭のフック・余白や文字組み・心理的な仕掛け・自分の制作への転用ポイントなど）';
}

/**
 * 対話履歴からObsidian保存用の要約（タイトル・刺さった理由）を生成する
 */
async function summarizeLinkEntry(session) {
    const isNsfw = session.mode === 'nsfw';
    const historyText = session.history
        .map(h => `${h.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${h.text}`)
        .join('\n');

    const prompt = isNsfw
        ? `以下の対話ログから、ユーザーが「なぜこの作品/参考が刺さったのか」の要点を抽出し、Obsidianのリスト1行の括弧内に収まる**簡潔で解像度の高い1〜2文**（日本語、80〜140文字程度）にまとめてください。
出力はまとめたテキストのみ（箇条書き記号や前置きは不要）。もしユーザーの言葉がそのまま良い表現なら活かしてください。

URL: ${session.url || 'なし'}
対話ログ:
${historyText}`
        : `以下の対話ログから、コンテンツ制作の参考ポイントを抽出し、JSON形式で出力してください。
{
  "title": "URLのページタイトル、または内容を表す簡潔なタイトル（20〜40文字）",
  "summary": "なぜ刺さったのか・自分の制作にどう活かせるかを簡潔にまとめた1〜3文（箇条書きにしやすい表現）"
}
※JSONのみを出力してください（コードブロック記号は不要）。

URL: ${session.url || 'なし'}
取得済みページタイトル: ${session.pageTitle || 'なし'}
対話ログ:
${historyText}`;

    try {
        const response = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{ text: prompt }],
        });
        const raw = (response.text || '').trim();

        if (isNsfw) {
            return {
                title: session.pageTitle || '参考スクリーンショット',
                summary: raw.replace(/^[-*]\s*/, '').replace(/\n+/g, ' '),
            };
        } else {
            const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
            const parsed = JSON.parse(jsonStr);
            return {
                title: parsed.title || session.pageTitle || '参考コンテンツ',
                summary: parsed.summary || session.history.filter(h => h.role === 'user').map(h => h.text).join(' / '),
            };
        }
    } catch (err) {
        console.warn('Gemini要約フォールバック:', err.message);
        const userNotes = session.history
            .filter(h => h.role === 'user')
            .map(h => h.text.replace(/https?:\/\/[^\s<>()]+/gi, '').trim())
            .filter(Boolean)
            .join(' / ');
        return {
            title: session.pageTitle || '参考コンテンツ',
            summary: userNotes || '刺さった参考資料として記録',
        };
    }
}

/**
 * Vaultに画像とMarkdownエントリを書き込む
 */
async function saveSessionToVault(session, vaultRootDir) {
    const isNsfw = session.mode === 'nsfw';
    const { title, summary } = await summarizeLinkEntry(session);

    // 1. 添付画像の保存
    const savedImageNames = [];
    if (session.images.length > 0) {
        const assetDir = isNsfw
            ? path.join(vaultRootDir, '03_Resources', '_private', 'assets')
            : path.join(vaultRootDir, '03_Resources', 'assets');
        await fs.mkdir(assetDir, { recursive: true });

        const now = new Date();
        const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
        for (let i = 0; i < session.images.length; i++) {
            const img = session.images[i];
            const filename = `discord_${stamp}_${i + 1}.${img.ext}`;
            const filepath = path.join(assetDir, filename);
            await fs.writeFile(filepath, img.buffer);
            savedImageNames.push(filename);
        }
    }

    // 2. Markdownファイルへの追記
    const resourcesDir = path.join(vaultRootDir, '03_Resources');
    await fs.mkdir(resourcesDir, { recursive: true });

    if (isNsfw) {
        const targetFile = path.join(resourcesDir, 'リンク収集.md');
        let content = '';
        try {
            content = await fs.readFile(targetFile, 'utf8');
        } catch (_) {
            content = '# リンク収集（AI画像の参考）\n\n## 未処理\n';
        }

        let entry = '';
        if (session.url) {
            entry = `- [ ] ${session.url} （${summary}）`;
        } else if (savedImageNames.length > 0) {
            entry = `- [ ] ![[${savedImageNames[0]}]] （${summary}）`;
        } else {
            entry = `- [ ] ${summary}`;
        }

        // URLと画像両方ある場合はサブリストで画像を埋め込む
        const extraImages = session.url ? savedImageNames : savedImageNames.slice(1);
        for (const imgName of extraImages) {
            entry += `\n\t- ![[${imgName}]]`;
        }

        const updated = `${content.trimEnd()}\n${entry}\n`;
        await fs.writeFile(targetFile, updated, 'utf8');

        return {
            filePath: '03_Resources/リンク収集.md',
            entryPreview: entry,
            savedImageNames,
        };
    } else {
        const targetFile = path.join(resourcesDir, 'いいと思ったもの.md');
        let content = '';
        try {
            content = await fs.readFile(targetFile, 'utf8');
        } catch (_) {
            content = '---\ntags: []\n---\n\n# いいと思ったもの\n';
        }

        const now = new Date();
        const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const heading = `## ${ym}`;

        let entry = session.url
            ? `- [${title}](${session.url})\n\t- ${summary}`
            : `- ${title}\n\t- ${summary}`;

        for (const imgName of savedImageNames) {
            entry += `\n\t- ![[${imgName}]]`;
        }

        // 末尾の空の "-" 行だけがある場合は除去してから追記
        let cleaned = content.replace(/\n-\s*$/, '');
        if (!cleaned.includes(heading)) {
            cleaned = `${cleaned.trimEnd()}\n\n${heading}\n${entry}\n`;
        } else {
            cleaned = `${cleaned.trimEnd()}\n${entry}\n`;
        }

        await fs.writeFile(targetFile, cleaned, 'utf8');

        return {
            filePath: '03_Resources/いいと思ったもの.md',
            entryPreview: entry,
            savedImageNames,
        };
    }
}

/**
 * 新規投稿をスレッドで受け付け、対話セッションを開始する
 */
async function startLinkSession(message, mode) {
    const url = extractUrl(message.content);
    const images = await downloadImageAttachments(message);
    const rawComment = (message.content || '').replace(/https?:\/\/[^\s<>()]+/gi, '').trim();

    if (!url && images.length === 0 && !rawComment) {
        return;
    }

    let waitReaction = null;
    try { waitReaction = await message.react('⏳'); } catch (_) {}

    const pageTitle = url ? await fetchPageTitle(url) : null;

    const threadBaseName = pageTitle
        ? pageTitle.slice(0, 40)
        : (rawComment ? rawComment.slice(0, 30) : (mode === 'nsfw' ? 'NSFW参考メモ' : 'コンテンツ参考メモ'));
    const threadName = `💡 ${threadBaseName}`;

    const thread = await message.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
    });

    const session = {
        mode,
        url,
        pageTitle,
        images,
        history: [],
        turnCount: 0,
        createdAt: Date.now(),
    };

    if (rawComment) {
        session.history.push({ role: 'user', text: rawComment });
    }

    const question = await generateFollowupQuestion(session);
    session.history.push({ role: 'model', text: question });
    activeSessions.set(thread.id, session);

    if (waitReaction) {
        try { await waitReaction.users.remove(message.client.user.id); } catch (_) {}
    }

    const targetLabel = mode === 'nsfw' ? '03_Resources/リンク収集.md' : '03_Resources/いいと思ったもの.md';
    await thread.send({
        content: `${question}\n\n-# 保存先: \`${targetLabel}\` ／ そのまま保存したい場合は下のボタンか「保存」と返信してください。`,
        components: [buildActionRow(thread.id)],
    });
}

/**
 * スレッド内でのユーザー返信を処理する
 */
async function handleThreadReply(message, { vaultRootDir, syncToGit, taskQueue, processQueue }) {
    const session = activeSessions.get(message.channelId);
    if (!session) return;

    const text = (message.content || '').trim();
    const additionalImages = await downloadImageAttachments(message);
    if (additionalImages.length > 0) {
        session.images.push(...additionalImages);
    }

    if (!text && additionalImages.length === 0) return;

    // キャンセルキーワード
    if (/^(キャンセル|中止|やめ|cancel)$/i.test(text)) {
        activeSessions.delete(message.channelId);
        await message.reply('🗑️ 記録をキャンセルしました。');
        return;
    }

    // 即保存キーワード
    if (/^(保存|記録|ok|完了|確定|save|done)$/i.test(text)) {
        await finalizeSession(message.channel, session, { vaultRootDir, syncToGit, taskQueue, processQueue, replyTarget: message });
        return;
    }

    if (text) {
        session.history.push({ role: 'user', text });
    }
    session.turnCount += 1;

    // 2往復目（ユーザーの返信が2回、または初回コメントあり＋返信1回で十分な長さ）に達したら自動で保存へ
    const hasEnoughDetail = session.turnCount >= 2 || (session.turnCount >= 1 && text.length >= 40);
    if (hasEnoughDetail) {
        await finalizeSession(message.channel, session, { vaultRootDir, syncToGit, taskQueue, processQueue, replyTarget: message });
        return;
    }

    // まだ1回目で短めならもう1問だけ深掘り
    let waitReaction = null;
    try { waitReaction = await message.react('💭'); } catch (_) {}

    const nextQuestion = await generateFollowupQuestion(session);
    session.history.push({ role: 'model', text: nextQuestion });

    if (waitReaction) {
        try { await waitReaction.users.remove(message.client.user.id); } catch (_) {}
    }

    await message.reply({
        content: `${nextQuestion}\n\n-# 次のお返事で自動保存します（今すぐ保存する場合は下のボタンをクリック）`,
        components: [buildActionRow(message.channelId)],
    });
}

/**
 * セッションを確定し、Vault保存＆Git同期を行う
 */
async function finalizeSession(channel, session, { vaultRootDir, syncToGit, taskQueue, processQueue, replyTarget = null }) {
    // 二重実行防止のため先に削除
    activeSessions.delete(channel.id);

    const statusMsg = replyTarget
        ? await replyTarget.reply('📝 内容を整理してObsidianに保存しています...')
        : await channel.send('📝 内容を整理してObsidianに保存しています...');

    taskQueue.push(async () => {
        try {
            const result = await saveSessionToVault(session, vaultRootDir);
            const commitMsg = session.mode === 'nsfw'
                ? 'Add NSFW link reference via Discord'
                : 'Add content reference to いいと思ったもの.md via Discord';
            await syncToGit(commitMsg);

            const imgNotice = result.savedImageNames.length > 0
                ? `\n🖼️ スクショ保存: \`${result.savedImageNames.join(', ')}\``
                : '';

            await statusMsg.edit(
                `✅ **\`${result.filePath}\` に記録・Git同期しました！**${imgNotice}\n\`\`\`markdown\n${result.entryPreview}\n\`\`\``
            );
        } catch (err) {
            console.error('Link save error:', err);
            await statusMsg.edit(`⚠️ 保存中にエラーが発生しました: ${err.message}`);
        }
    });
    processQueue();
}

module.exports = {
    hasSession,
    getSession,
    deleteSession,
    startLinkSession,
    handleThreadReply,
    finalizeSession,
};
