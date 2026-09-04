const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execSync } = require('child_process');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.COO_CHANNEL_ID;
const VAULT_PATH = process.env.VAULT_PATH || '/home/tnuma/my-vault';

// 1. Vault を最新状態に git pull
function syncVault() {
  try {
    console.log(`[Git] Pulling latest changes in ${VAULT_PATH}...`);
    execSync(`git -C "${VAULT_PATH}" pull`, { stdio: 'pipe' });
    console.log('[Git] Pull completed successfully.');
  } catch (error) {
    console.warn('[Git] Pull warning/failed (continuing with local data):', error.message);
  }
}

// 再帰的に .md ファイルを取得
function getAllMarkdownFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;

  const files = fs.readdirSync(dirPath);
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (!file.startsWith('.')) {
        getAllMarkdownFiles(fullPath, arrayOfFiles);
      }
    } else if (file.endsWith('.md')) {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

// 01_Projects 配下のステータス走査 & 滞留検知
function scanVaultStatus() {
  const projectsDir = path.join(VAULT_PATH, '01_Projects');
  const allFiles = getAllMarkdownFiles(projectsDir);
  const now = Date.now();

  const channels = {};
  const stalledTasks = []; // 滞留ボトルネック

  allFiles.forEach(filePath => {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data } = matter(fileContent);

      if (data && data.status) {
        const channelName = data.channel || 'unassigned';
        const status = data.status.toLowerCase();
        const title = data.title || path.basename(filePath, '.md');

        // ★ 改修ポイント1: mtimeではなく status_since (YYYY-MM-DD) から日数を計算
        let ageDays = 0;
        if (data.status_since) {
          const sinceDate = new Date(data.status_since);
          if (!isNaN(sinceDate.getTime())) {
            ageDays = Math.floor((now - sinceDate.getTime()) / (1000 * 60 * 60 * 24));
          }
        } else {
          // 移行前の古いノート用のフォールバック（mtime）
          const stats = fs.statSync(filePath);
          ageDays = Math.floor((now - stats.mtimeMs) / (1000 * 60 * 60 * 24));
        }

        if (!channels[channelName]) {
          channels[channelName] = { inbox: [], drafting: [], ready: [], 'in-production': [], shipped: [], shelved: [] };
        }

        const item = { title, file: path.basename(filePath), ageDays };

        // ★ 改修ポイント2: STATUS_SPEC.md に沿った全ステータスの網羅
        switch (status) {
          case 'inbox':
            channels[channelName].inbox.push(item);
            break;
          case 'drafting':
            channels[channelName].drafting.push(item);
            if (ageDays >= 5) stalledTasks.push({ channel: channelName, status: '執筆停止', title, ageDays });
            break;
          case 'ready':
            channels[channelName].ready.push(item);
            // readyの長期放置もアラート候補にできますが、今回は除外
            break;
          case 'in-production':
            channels[channelName]['in-production'].push(item);
            // 収録・編集の滞留は7日をボトルネックとして検知
            if (ageDays >= 7) stalledTasks.push({ channel: channelName, status: '収録/編集停滞', title, ageDays });
            break;
          case 'shipped':
            channels[channelName].shipped.push(item);
            break;
          case 'shelved':
            channels[channelName].shelved.push(item);
            break;
          // done は 04_Archive へ移動される前提のため無視
        }
      }
    } catch (e) {
      // パース失敗したファイルはスキップ
    }
  });

  return { channels, stalledTasks };
}

// 00_Inbox 配下のメモ一覧走査
function getInboxMemos() {
  const inboxDir = path.join(VAULT_PATH, '00_Inbox');
  if (!fs.existsSync(inboxDir)) return [];

  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md') && f !== 'NEXT_PITCH.md');
  const now = Date.now();

  return files.map(file => {
    const filePath = path.join(inboxDir, file);
    let ageDays = 0;
    
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data } = matter(fileContent);
      
      // Inboxはstatusを持たないため、researcher.jsが出力する `date` を基準にする
      if (data && data.date) {
        const createdDate = new Date(data.date);
        if (!isNaN(createdDate.getTime())) {
          ageDays = Math.floor((now - createdDate.getTime()) / (1000 * 60 * 60 * 24));
        } else {
          ageDays = Math.floor((now - fs.statSync(filePath).mtimeMs) / (1000 * 60 * 60 * 24));
        }
      } else {
        ageDays = Math.floor((now - fs.statSync(filePath).mtimeMs) / (1000 * 60 * 60 * 24));
      }
    } catch (e) {
      ageDays = Math.floor((now - fs.statSync(filePath).mtimeMs) / (1000 * 60 * 60 * 24));
    }

    return { name: file.replace('.md', ''), ageDays };
  }).sort((a, b) => b.ageDays - a.ageDays);
}

async function runCOOPatrol() {
  // 巡回前に最新のリモートコミットを取得
  syncVault();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    try {
      const channel = await client.channels.fetch(CHANNEL_ID);
      if (!channel) {
        console.error('指定されたチャンネルが見つかりません。');
        process.exit(1);
      }

      const { channels, stalledTasks } = scanVaultStatus();
      const inboxMemos = getInboxMemos();
      const fields = [];

      // 1. 長期滞留アラート（ボトルネックがある場合のみ上部に強調表示）
      const expiredMemos = inboxMemos.filter(m => m.ageDays >= 7);
      const alertLines = [];

      if (stalledTasks.length > 0) {
        alertLines.push('**🚧 プロジェクト滞留アラート:**');
        stalledTasks.forEach(s => alertLines.push(`  • [${s.channel}] \`${s.title}\` (${s.status}: ${s.ageDays}日経過)`));
      }
      if (expiredMemos.length > 0) {
        alertLines.push('**⏳ 思考メモの賞味期限切れ (7日以上経過):**');
        expiredMemos.slice(0, 3).forEach(m => alertLines.push(`  • \`${m.name}\` (${m.ageDays}日前)`));
      }

      if (alertLines.length > 0) {
        fields.push({
          name: '⚠️ ボトルネック検知（要アクション）',
          value: alertLines.join('\n') + '\n*※作業を進めるか、アーカイブ (done) / 休眠 (shelved) に落としてください。*'
        });
      }

      // 2. 進行中パイプライン
      const channelKeys = Object.keys(channels);
      if (channelKeys.length === 0) {
        fields.push({
          name: '🎬 進行中パイプライン',
          value: '進行中のプロジェクトはありません。'
        });
      } else {
        channelKeys.forEach(ch => {
          const lines = [];
          const data = channels[ch];

          if (data['in-production'].length > 0) {
            lines.push(`🎥 **収録・編集中 (in-production):**\n` + data['in-production'].map(i => `  • \`${i.title}\` (${i.ageDays}日目)`).join('\n'));
          }
          if (data.ready.length > 0) {
            lines.push(`🎯 **準備完了・収録待ち (ready):**\n` + data.ready.map(i => `  • \`${i.title}\` (${i.ageDays}日待機)`).join('\n'));
          }
          if (data.drafting.length > 0) {
            lines.push(`✍️ **執筆・推敲中 (drafting):**\n` + data.drafting.map(i => `  • \`${i.title}\` (${i.ageDays}日目)`).join('\n'));
          }
          if (data.shipped.length > 0) {
            lines.push(`🚀 **出荷済み・派生還元待ち (shipped):**\n` + data.shipped.map(i => `  • \`${i.title}\``).join('\n'));
          }
          if (data.shelved.length > 0) {
            lines.push(`💤 **休眠在庫 (shelved):**\n` + data.shelved.map(i => `  • \`${i.title}\``).join('\n'));
          }
          if (data.inbox.length > 0) {
            lines.push(`💡 **ネタ・仕込み (inbox):**\n` + data.inbox.map(i => `  • \`${i.title}\``).join('\n'));
          }

          if (lines.length > 0) {
            fields.push({
              name: `📦 チャンネル: ${ch}`,
              value: lines.join('\n')
            });
          }
        });
      }

      // 3. Inboxの直近状況
      if (inboxMemos.length > 0) {
        const memoList = inboxMemos.slice(0, 5).map(m => `• \`${m.name}\` (${m.ageDays}日前)`).join('\n');
        fields.push({
          name: `📥 直近の未整理思考ログ (${inboxMemos.length}件中)`,
          value: memoList
        });
      }

      const embed = new EmbedBuilder()
        .setTitle('🧭 COO Morning Operation Brief')
        .setDescription('本日の制作状況および滞留ボトルネックの確認です。')
        .setColor(alertLines.length > 0 ? 0xd97706 : 0x2b2d31) // ボトルネックがあればアンバー（警告色）
        .addFields(fields)
        .setFooter({ text: 'Ship, then polish. — tnumaStudio' })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      console.log('COO通知を送信しました。');
    } catch (err) {
      console.error('送信エラー:', err.message);
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  await client.login(TOKEN);
}

runCOOPatrol();