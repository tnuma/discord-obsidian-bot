const {
    joinVoiceChannel,
    EndBehaviorType,
    VoiceConnectionStatus,
    entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// WAV ヘッダ (44 bytes) をインメモリ生成
function createWavHeader(dataLength, sampleRate = 48000, channels = 2, bitDepth = 16) {
    const buffer = Buffer.alloc(44);
    const byteRate = sampleRate * channels * (bitDepth / 8);
    const blockAlign = channels * (bitDepth / 8);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Subchunk1Size
    buffer.writeUInt16LE(1, 20);  // AudioFormat (PCM)
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataLength, 40);

    return buffer;
}

// Discordの2000文字制限に対応したメッセージ分割送信
async function sendLongMessage(channel, content) {
    const MAX_LEN = 1900;
    if (content.length <= MAX_LEN) {
        return await channel.send(content);
    }
    const lines = content.split('\n');
    let current = '';
    for (const line of lines) {
        if ((current + '\n' + line).length > MAX_LEN) {
            await channel.send(current);
            current = line;
        } else {
            current = current ? current + '\n' + line : line;
        }
    }
    if (current) {
        await channel.send(current);
    }
}

// 思考生ログ整形用のシステムプロンプト
const systemPromptThoughtMemo = `
あなたはプロの思考ログ文字起こしエディターです。
提供された音声は、ユーザーが1人でアイデアや頭の中の思考を声に出して吹き込んだ「思考の生ログ」です。
ユーザーの思考の文脈や熱量、論理展開を完全に維持しながら、Obsidianのナレッジベースに保存する「生ログ」として読めるテキストに整形してください。

【整形のルール】
1. 音声内容の忠実な保持（勝手な要約は禁止）:
   ユーザーが話した思考のプロセス、具体例、感情、疑問、気づきは省略せずにすべて記述してください。短く要約するのではなく、話した内容をしっかり文章化してください。
2. フィラーの完全除去:
   「えーと」「あのー」「なんか」「えー」「まぁ」「ほら」「その」などの無意味なつなぎ言葉・口癖は自然に削除してください。
3. 口頭での言い直しの整理:
   口頭で言い淀んだり、同じことを言い直している部分は、最も自然な一文になるよう整えてください。
4. 自然な段落と改行:
   思考のまとまりごとに適切な改行と空行を入れて段落を分け、スラスラ読めるようにしてください。
5. 文体:
   話した本人の思考メモ・独白のトーンを保ちつつ、読みやすい日本語に整えてください。

※ 「承知しました」「文字起こし結果です」といった挨拶や注釈は一切含めず、整形した思考生ログの本文のみを出力してください。
`;

class VoiceTranscriber {
    constructor(client, options = {}) {
        this.client = client;
        this.targetVoiceChannelId = options.voiceChannelId || process.env.VOICE_CHANNEL_ID;
        this.outputChannelId = options.outputChannelId || process.env.TRANSCRIPT_CHANNEL_ID;
        this.geminiModel = options.geminiModel || process.env.VOICE_GEMINI_MODEL || 'gemini-3.6-flash';
        this.onTranscribeComplete = options.onTranscribeComplete || null;

        // セッション管理
        this.connection = null;
        this.sessionChunks = [];
        this.activeUserId = null;
        this.sessionStartTime = null;
        this.isProcessing = false;
        this.activeSubscriptions = new Set();
    }

    init() {
        console.log(`🎙️ VoiceTranscriber initialized (Target VC: ${this.targetVoiceChannelId || 'Not set'}, Model: ${this.geminiModel})`);

        this.client.on('voiceStateUpdate', async (oldState, newState) => {
            await this.handleVoiceStateUpdate(oldState, newState);
        });
    }

    async handleVoiceStateUpdate(oldState, newState) {
        const userId = newState.id || oldState.id;
        // Bot自身のイベントは無視
        if (userId === this.client.user.id) return;

        // 1. ユーザーが対象VCに入室したとき（自動入室セッション開始）
        const joinedTarget = this.targetVoiceChannelId && newState.channelId === this.targetVoiceChannelId;
        if (joinedTarget && !this.connection) {
            console.log(`👤 ユーザー [${newState.member?.displayName || userId}] がVCに入室しました。録音セッションを開始します...`);
            await this.startSession(newState.channel, userId);
            return;
        }

        // 2. ユーザーが現在接続中のVCから退出したとき（セッション終了・文字起こし実行）
        const currentChannelId = this.connection?.joinConfig?.channelId || this.targetVoiceChannelId;
        const leftSessionChannel = currentChannelId && oldState.channelId === currentChannelId && newState.channelId !== currentChannelId;

        if (leftSessionChannel && this.connection && this.activeUserId === userId) {
            console.log(`🚪 ユーザー [${oldState.member?.displayName || userId}] がVCから退出しました。録音を終了し、思考ログを生成します...`);
            await this.endSessionAndTranscribe(oldState.member?.displayName || 'User');
        }
    }

    async startSession(voiceChannel, userId) {
        try {
            this.activeUserId = userId;
            this.sessionChunks = [];
            this.sessionStartTime = new Date();
            this.activeSubscriptions.clear();

            this.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: true,
            });

            await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
            console.log(`✅ VC [${voiceChannel.name}] に接続しました。思考の吹き込み待機中...`);

            // 録音開始をチャットに通知（視覚的フィードバック）
            const targetChannelId = this.outputChannelId || voiceChannel.id;
            const notifyChannel = await this.client.channels.fetch(targetChannelId).catch(() => null);
            if (notifyChannel) {
                await notifyChannel.send(`🎙️ **[思考ログ]** \`${voiceChannel.name}\` で録音を開始しました！\n頭の中の思考を声に出して喋ってください。話し終えてVCを退出すると自動で文字起こし＆整形されます。`).catch(() => {});
            }

            const receiver = this.connection.receiver;

            receiver.speaking.on('start', (speakingUserId) => {
                // セッション対象のユーザーのみ録音
                if (speakingUserId !== this.activeUserId) return;

                // 既に購読中の場合は二重購読を防ぐ
                if (this.activeSubscriptions.has(speakingUserId)) return;
                this.activeSubscriptions.add(speakingUserId);

                try {
                    const audioStream = receiver.subscribe(speakingUserId, {
                        end: {
                            behavior: EndBehaviorType.AfterSilence,
                            duration: 1500, // 1.5秒の無音で一旦ストリーム終了
                        },
                    });

                    const decoder = new prism.opus.Decoder({
                        rate: 48000,
                        channels: 2,
                        frameSize: 960,
                    });

                    audioStream.pipe(decoder);

                    decoder.on('data', (chunk) => {
                        this.sessionChunks.push(chunk);
                    });

                    decoder.on('error', (err) => {
                        console.error('Opus decoder error:', err);
                    });

                    audioStream.on('end', () => {
                        this.activeSubscriptions.delete(speakingUserId);
                    });

                    audioStream.on('error', (err) => {
                        console.error('Audio stream error:', err);
                        this.activeSubscriptions.delete(speakingUserId);
                    });

                } catch (err) {
                    console.error('Receiver subscribe error:', err);
                    this.activeSubscriptions.delete(speakingUserId);
                }
            });

        } catch (error) {
            console.error('Failed to start voice session:', error);
            this.cleanup();
        }
    }

    async endSessionAndTranscribe(userName) {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            // 直前のパケットが流れるのを少し待つ
            await new Promise((resolve) => setTimeout(resolve, 800));

            // 接続の破棄
            this.cleanupConnection();

            const chunks = [...this.sessionChunks];
            const startTime = this.sessionStartTime;
            this.sessionChunks = [];
            this.activeUserId = null;

            if (chunks.length === 0) {
                console.log('ℹ️ 音声データが記録されなかったため、文字起こしをスキップします。');
                return;
            }

            const pcmBuffer = Buffer.concat(chunks);
            // 48000Hz * 2ch * 2bytes = 192,000 bytes/sec
            const durationSec = (pcmBuffer.length / 192000).toFixed(1);
            console.log(`📊 録音完了: 合計データ長 ${pcmBuffer.length} bytes (実発言時間: 約 ${durationSec} 秒)`);

            // 2秒未満の発言（マイクの誤検知など）はスキップ
            if (durationSec < 2.0) {
                console.log('⚠️ 音声が短すぎるため（2秒未満）、文字起こしをスキップします。');
                return;
            }

            // WAV ヘッダを付与
            const wavHeader = createWavHeader(pcmBuffer.length, 48000, 2, 16);
            const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
            const wavBase64 = wavBuffer.toString('base64');

            // 送信先チャンネルの特定
            const targetChannelId = this.outputChannelId || this.targetVoiceChannelId;
            const outputChannel = await this.client.channels.fetch(targetChannelId).catch(() => null);

            let waitMsg = null;
            if (outputChannel) {
                waitMsg = await outputChannel.send(`🎙️ **[思考ログ]** 音声を解析・整形中... (録音時間: 約${durationSec}秒)`).catch(() => null);
            }

            console.log(`🤖 Gemini API (${this.geminiModel}) に音声を送信中...`);

            const response = await ai.models.generateContent({
                model: this.geminiModel,
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                inlineData: {
                                    mimeType: 'audio/wav',
                                    data: wavBase64,
                                },
                            },
                            {
                                text: systemPromptThoughtMemo,
                            },
                        ],
                    },
                ],
            });

            const formattedText = response.text ? response.text.trim() : '';

            if (waitMsg) {
                await waitMsg.delete().catch(() => {});
            }

            if (!formattedText) {
                console.log('⚠️ 文字起こし結果が空でした。');
                if (outputChannel) {
                    await outputChannel.send('⚠️ 音声から思考ログを抽出できませんでした（無音または聞き取り不能）。');
                }
                return;
            }

            const nowStr = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
            const messagePayload = `📝 **思考生ログ** (${nowStr})\n---\n${formattedText}`;

            if (outputChannel) {
                await sendLongMessage(outputChannel, messagePayload);
                console.log('✅ 思考ログをチャンネルに投稿しました！');
            }

            // コールバック（Obsidian同期など外部連携用）
            if (typeof this.onTranscribeComplete === 'function') {
                await this.onTranscribeComplete(formattedText, {
                    userName,
                    durationSec,
                    timestamp: startTime,
                });
            }

        } catch (error) {
            console.error('❌ 文字起こし・整形処理エラー:', error);
            const targetChannelId = this.outputChannelId || this.targetVoiceChannelId;
            const outputChannel = await this.client.channels.fetch(targetChannelId).catch(() => null);
            if (outputChannel) {
                await outputChannel.send('⚠️ 思考ログの文字起こし中にエラーが発生しました。詳細はログをご確認ください。').catch(() => {});
            }
        } finally {
            this.cleanup();
            this.isProcessing = false;
        }
    }

    cleanupConnection() {
        if (this.connection) {
            try {
                this.connection.destroy();
            } catch (_) {}
            this.connection = null;
        }
    }

    cleanup() {
        this.cleanupConnection();
        this.sessionChunks = [];
        this.activeUserId = null;
        this.activeSubscriptions.clear();
    }
}

module.exports = { VoiceTranscriber };
