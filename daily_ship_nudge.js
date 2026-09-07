/**
 * daily_ship_nudge.js
 * 
 * 朝6:30の作業開始に合わせて実行されるShipリマインダー。
 * 最新の週次レビューから vidIQ 推奨投稿タイミングを解析し、
 * 本日出すべき案件や推奨時間帯をDiscord（COOチャンネル）へ通知する。
 * 
 * ラズパイ上の PM2 から毎朝 06:30 に実行されることを想定。
 * オプション:
 *   --dry-run  : Discord送信を行わず、コンソールに通知内容を出力
 *   --no-pull  : Git pullをスキップ
 */

const fs = require('fs');
const path = require('path');
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

let Discord = null;
try { Discord = require('discord.js'); } catch (_) {}

const { analyzeTodayShipTarget } = require('./ship_target_analyzer');

// ==========================================
// ⚙️ 設定エリア
// ==========================================
const TOKEN = process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.COO_CHANNEL_ID;
const VAULT_PATH = process.env.VAULT_PATH || '/home/tnuma/my-vault';

// コマンドライン引数
const args = process.argv.slice(2);
const IS_DRY_RUN = args.includes('--dry-run');
const NO_PULL = args.includes('--no-pull');

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

async function main() {
    console.log('==================================================');
    console.log(`[Daily Ship Nudge] 起動: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
    console.log(`[Vault Path]: ${VAULT_PATH}`);
    console.log('==================================================');

    // 1. Vaultを最新化
    syncVault();

    // 2. 本日のShipターゲットを分析
    const analysis = analyzeTodayShipTarget(VAULT_PATH);
    const { todayDayName, todayTargets, upcomingTargets, otherActive } = analysis;

    console.log(`[Analyzer] 本日の曜日: ${todayDayName}曜日 / ターゲット該当CH数: ${todayTargets.length}`);

    // 3. Discord Embedの構築
    let embedTitle = '';
    let embedDesc = '';
    let embedColor = 0x3498db; // デフォルト: ブルー
    const fields = [];

    if (todayTargets.length > 0) {
        // 今日推奨投稿枠がある場合
        const mainTarget = todayTargets[0];
        embedTitle = `🎯 【本日のShipターゲット】${todayDayName}曜 ${mainTarget.slot.timeRange} 枠`;
        embedColor = 0xe67e22; // アンバー/オレンジ（集中・勝負色）

        embedDesc = `おはようございます！6:30の作業開始タイムです。\n本日は vidIQ による **${mainTarget.channelName}** の推奨投稿枠（**${mainTarget.slot.timeRange}**）です！`;

        // 該当チャンネルの案件情報
        todayTargets.forEach(target => {
            const lines = [];

            if (target.readyProjects.length > 0) {
                lines.push('🔥 **確定済み・あとは出すだけ (ready):**');
                target.readyProjects.forEach(p => {
                    lines.push(`  • **『${p.title}』** (${p.ageDays}日待機)`);
                    lines.push(`    👉 今日の ${target.slot.timeRange} 公開を狙い、朝の作業で最終チェック・Shipしましょう！`);
                });
            }

            if (target.inProdProjects.length > 0) {
                lines.push('⚡ **制作進行中・今日仕上げ推奨 (in-production):**');
                target.inProdProjects.forEach(p => {
                    lines.push(`  • **『${p.title}』** (${p.ageDays}日目)`);
                    lines.push(`    👉 今夜のゴールデンタイム（${target.slot.timeRange}）公開を目指して、朝の作業で一歩進めましょう！`);
                });
            }

            if (lines.length === 0) {
                lines.push('※現在、このチャンネルに進行中の案件はありません。');
                lines.push('  （ドラフトからの起票や企画検討に充てるのがおすすめです）');
            }

            fields.push({
                name: `🎬 ターゲットCH: ${target.channelName} [推奨 ${target.slot.timeRange}]`,
                value: lines.join('\n')
            });
        });

    } else {
        // 今日は集中推奨枠がない日（仕込み・制作デイ）
        embedTitle = `🛠️ 【本日のフォーカス】制作・仕込みデイ（${todayDayName}曜日）`;
        embedColor = 0x2b2d31; // シックなダークグレー

        embedDesc = `おはようございます！6:30の作業開始タイムです。\n本日は特定チャンネルの集中推奨枠はありません。次回推奨枠に向けた制作や、滞留案件の解消に最適な日です。`;

        // ready案件があるかチェック
        const allReady = [];
        upcomingTargets.forEach(t => allReady.push(...t.readyProjects));
        allReady.push(...otherActive.filter(p => p.status === 'ready'));

        if (allReady.length > 0) {
            const readyLines = allReady.map(p => `• **[${p.channelName}] 『${p.title}』** (${p.ageDays}日待機)`).join('\n');
            fields.push({
                name: '🎯 収録・公開待ちの案件 (ready)',
                value: readyLines + '\n*迷ったら一番上の案件を撮る・進めるのが最優先です。*'
            });
        }
    }

    // 他チャンネルの次回推奨枠・仕掛かり状況
    if (upcomingTargets.length > 0) {
        const upcomingLines = upcomingTargets.map(t => {
            const slotStr = t.slot ? `${t.slot.day}曜 ${t.slot.timeRange}` : '未定';
            const countStr = t.readyProjects.length > 0
                ? `ready ${t.readyProjects.length}件`
                : (t.inProdProjects.length > 0 ? `進行中 ${t.inProdProjects.length}件` : '在庫なし');
            return `• **${t.channelName}**: 次回推奨 **${slotStr}** （${countStr}）`;
        }).join('\n');

        fields.push({
            name: '🗓️ 他チャンネルの次回推奨枠',
            value: upcomingLines
        });
    }

    // 南信堂等の他仕掛かり案件
    if (otherActive.length > 0) {
        const otherLines = otherActive.map(p => `• [${p.channelName}] 『${p.title}』 (${p.status}: ${p.ageDays}日目)`).join('\n');
        fields.push({
            name: '📦 その他の進行中案件',
            value: otherLines
        });
    }

    // DRY RUN 出力
    if (IS_DRY_RUN) {
        console.log('\n--- 🧪 DRY RUN 出力 ---');
        console.log(`Title: ${embedTitle}`);
        console.log(`Description:\n${embedDesc}`);
        console.log('\nFields:');
        fields.forEach(f => {
            console.log(`\n[${f.name}]\n${f.value}`);
        });
        console.log('---------------------------');
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

    console.log(`📡 Discord (COOチャンネル) へ通知を送信します...`);
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

            const embed = new EmbedBuilder()
                .setTitle(embedTitle)
                .setDescription(embedDesc)
                .setColor(embedColor)
                .addFields(fields)
                .setFooter({ text: 'Ship, then polish. — 6:30 Operation Start' })
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            console.log(`📨 送信完了: ${embedTitle}`);
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
