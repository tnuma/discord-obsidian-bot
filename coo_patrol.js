const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { execSync } = require('child_process');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config({ path: path.join(__dirname, '.env') });
 
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.COO_CHANNEL_ID;
const VAULT_PATH = process.env.VAULT_PATH || '/home/tnuma/my-vault';
const HEALTH_CHECK_WINDOW_DAYS = 8; // 週次Scheduled Task（Ship2130/Moc2300jst/Ch23）の生存確認に使う猶予日数
 
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
 
// status付きファイル1件を channels / stalledTasks へ分類する。
// 01_Projects 配下と、00_Inbox 配下のBot下書き（例: 00_Inbox/Nanshindo）の両方から呼ばれる共通ロジック。
function classifyStatusFile(filePath, data, now, channels, stalledTasks) {
  const channelName = data.channel || 'unassigned';
  const status = data.status.toLowerCase();
  const title = data.title || path.basename(filePath, '.md');
 
  let ageDays = 0;
  if (data.status_since) {
    const sinceDate = new Date(data.status_since);
    if (!isNaN(sinceDate.getTime())) {
      ageDays = Math.floor((now - sinceDate.getTime()) / (1000 * 60 * 60 * 24));
    }
  } else {
    // status_since が無い古いノート用のフォールバック（mtime）
    const stats = fs.statSync(filePath);
    ageDays = Math.floor((now - stats.mtimeMs) / (1000 * 60 * 60 * 24));
  }
 
  if (!channels[channelName]) {
    channels[channelName] = { inbox: [], drafting: [], ready: [], 'in-production': [], shipped: [], shelved: [] };
  }
 
  const item = { title, file: path.basename(filePath), ageDays };
 
  // STATUS_SPEC.md に沿った全ステータスの網羅
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
 
// 01_Projects 配下のステータス走査 & 滞留検知
function scanVaultStatus(now, channels, stalledTasks) {
  const projectsDir = path.join(VAULT_PATH, '01_Projects');
  const allFiles = getAllMarkdownFiles(projectsDir);
 
  allFiles.forEach(filePath => {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data } = matter(fileContent);
      if (data && data.status) {
        classifyStatusFile(filePath, data, now, channels, stalledTasks);
      }
    } catch (e) {
      // パース失敗したファイルはスキップ
    }
  });
}
 
// 00_Inbox 配下の通常思考メモ走査（brewing フォルダは除外）。
function getInboxMemos(now, channels, stalledTasks) {
  const inboxDir = path.join(VAULT_PATH, '00_Inbox');
  const allFiles = getAllMarkdownFiles(inboxDir).filter(f => {
    const base = path.basename(f);
    if (base === 'NEXT_PITCH.md') return false;
    // brewing フォルダ配下の未発酵メモは除外（getBrewingMemos で別途管理）
    if (f.includes('/00_Inbox/brewing/') || f.includes('\\00_Inbox\\brewing\\')) return false;
    return true;
  });

  const plainMemos = [];

  allFiles.forEach(filePath => {
    let data = null;
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      ({ data } = matter(fileContent));
    } catch (e) {
      return; // パース失敗はスキップ
    }

    if (data && data.status) {
      // status付き（南信堂Bot下書き等）＝ 01_Projectsと同じ滞留基準を適用
      classifyStatusFile(filePath, data, now, channels, stalledTasks);
      return;
    }

    // statusなし＝通常の思考メモ。researcher.js等が出力する `date` を基準にする
    let ageDays = 0;
    try {
      if (data && data.date) {
        const createdDate = new Date(data.date);
        ageDays = !isNaN(createdDate.getTime())
          ? Math.floor((now - createdDate.getTime()) / (1000 * 60 * 60 * 24))
          : Math.floor((now - fs.statSync(filePath).mtimeMs) / (1000 * 60 * 60 * 24));
      } else {
        ageDays = Math.floor((now - fs.statSync(filePath).mtimeMs) / (1000 * 60 * 60 * 24));
      }
    } catch (e) {
      ageDays = 0;
    }

    plainMemos.push({ name: path.basename(filePath, '.md'), ageDays });
  });

  plainMemos.sort((a, b) => b.ageDays - a.ageDays);
  return plainMemos;
}

// 00_Inbox/brewing 配下の未発酵メモ走査。
function getBrewingMemos(now) {
  const brewingDir = path.join(VAULT_PATH, '00_Inbox', 'brewing');
  if (!fs.existsSync(brewingDir)) return [];

  const files = getAllMarkdownFiles(brewingDir);
  const items = [];

  files.forEach(filePath => {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data } = matter(fileContent);
      const title = data.title || path.basename(filePath, '.md');
      const status = (data.status || 'brewing').toLowerCase();
      const isVoice = (Array.isArray(data.tags) && data.tags.includes('voice-memo')) || data.source === 'voice-input';

      let ageDays = 0;
      if (data.date) {
        const d = new Date(data.date);
        ageDays = !isNaN(d.getTime()) ? Math.floor((now - d.getTime()) / (1000 * 60 * 60 * 24)) : 0;
      } else {
        ageDays = Math.floor((now - fs.statSync(filePath).mtimeMs) / (1000 * 60 * 60 * 24));
      }

      items.push({ title, file: path.basename(filePath), status, ageDays, isVoice });
    } catch (_) {}
  });

  items.sort((a, b) => b.ageDays - a.ageDays);
  return items;
}
 
// Claude Scheduled Task（Ship2130 / Moc2300 jst / Ch23）は「Macが起動中のみ」実行される。
// Macがスリープ・オフラインの間は静かに止まるだけで、誰にも気づかれない構造だったため、
// 期待される成果物の更新日時から簡易的に生存確認する（2026-09-04 追加）。
function checkScheduledTaskHealth(now) {
  const WINDOW_MS = HEALTH_CHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const alerts = [];
 
  function newestMtime(dirPath) {
    const files = getAllMarkdownFiles(dirPath);
    let newest = 0;
    files.forEach(f => {
      try {
        const m = fs.statSync(f).mtimeMs;
        if (m > newest) newest = m;
      } catch (e) { /* ignore */ }
    });
    return newest;
  }
 
  const dirChecks = [
    { name: '週次Ship/Buildレビュー（Ship2130）', dir: path.join(VAULT_PATH, '06_Weekly_Reviews') },
    { name: 'MOC＆リンク整理（Moc2300 jst）', dir: path.join(VAULT_PATH, '02_Areas/MOCs') },
  ];
 
  dirChecks.forEach(c => {
    const newest = newestMtime(c.dir);
    if (newest === 0 || (now - newest) > WINDOW_MS) {
      alerts.push(`${c.name}：直近${HEALTH_CHECK_WINDOW_DAYS}日間の更新がありません`);
    }
  });
 
  const pitchPath = path.join(VAULT_PATH, '00_Inbox', 'NEXT_PITCH.md');
  try {
    const m = fs.statSync(pitchPath).mtimeMs;
    if ((now - m) > WINDOW_MS) {
      alerts.push(`週次企画ピッチ（Ch23）：NEXT_PITCH.mdが${HEALTH_CHECK_WINDOW_DAYS}日以上更新されていません`);
    }
  } catch (e) {
    alerts.push('週次企画ピッチ（Ch23）：NEXT_PITCH.mdが見つかりません');
  }
 
  return alerts;
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
 
      const now = Date.now();
      const channels = {};
      const stalledTasks = []; // 滞留ボトルネック
 
      scanVaultStatus(now, channels, stalledTasks);
      const inboxMemos = getInboxMemos(now, channels, stalledTasks);
      const brewingMemos = getBrewingMemos(now);
      const scheduleAlerts = checkScheduledTaskHealth(now);
      const fields = [];

      // 1. 長期滞留アラート（ボトルネックがある場合のみ上部に強調表示）
      const expiredMemos = inboxMemos.filter(m => m.ageDays >= 7);
      const stalledBrewing = brewingMemos.filter(m => m.ageDays >= 14 && m.status !== 'brewed');
      const readyToSublimate = brewingMemos.filter(m => m.status === 'brewed' || m.status === 'ready');
      const alertLines = [];

      if (readyToSublimate.length > 0) {
        alertLines.push('**☕ 発酵完了メモ（昇華待機中）:**');
        readyToSublimate.forEach(m => alertLines.push(`  • \`${m.title}\` (\`status: ${m.status}\` 検知)`));
      }
      if (stalledTasks.length > 0) {
        alertLines.push('**🚧 プロジェクト滞留アラート:**');
        stalledTasks.forEach(s => alertLines.push(`  • [${s.channel}] \`${s.title}\` (${s.status}: ${s.ageDays}日経過)`));
      }
      if (expiredMemos.length > 0) {
        alertLines.push('**⏳ 思考メモの賞味期限切れ (7日以上経過):**');
        expiredMemos.slice(0, 3).forEach(m => alertLines.push(`  • \`${m.name}\` (${m.ageDays}日前)`));
      }
      if (stalledBrewing.length > 0) {
        alertLines.push('**🌱 思考の種・長期放置 (14日以上熟成中):**');
        stalledBrewing.slice(0, 3).forEach(m => alertLines.push(`  • \`${m.title}\` (${m.ageDays}日経過：そろそろ発酵させるか休眠させますか？)`));
      }
      if (scheduleAlerts.length > 0) {
        alertLines.push('**🗓️ Scheduled Task 未実行の疑い:**');
        scheduleAlerts.forEach(a => alertLines.push(`  • ${a}`));
      }

      if (alertLines.length > 0) {
        fields.push({
          name: '⚠️ ボトルネック ＆ 注目アクション',
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

      // 3. 🧪 思考の醸造所（00_Inbox/brewing）
      if (brewingMemos.length > 0) {
        const activeBrewing = brewingMemos.filter(m => m.status !== 'brewed' && m.status !== 'ready');
        const brewLines = [];

        if (readyToSublimate.length > 0) {
          brewLines.push('☕ **発酵完了（昇華待機中）:**');
          readyToSublimate.forEach(m => brewLines.push(`  • \`${m.title}\` (\`status: ${m.status}\`)`));
        }

        if (activeBrewing.length > 0) {
          if (readyToSublimate.length > 0) brewLines.push('');
          brewLines.push('🌱 **発酵中の思索・アイデア:**');
          activeBrewing.slice(0, 5).forEach(m => {
            const icon = m.isVoice ? '🎙️' : '✍️';
            const alertTag = m.ageDays >= 10 ? ' ⏳' : '';
            brewLines.push(`  • ${icon} \`${m.title}\` (${m.ageDays}日熟成中${alertTag})`);
          });
          if (activeBrewing.length > 5) {
            brewLines.push(`  *...他 ${activeBrewing.length - 5} 件*`);
          }
        }

        brewLines.push('\n*※Obsidianで追記し `status: brewed` に書き換えると、Botが自動で正規構造化メモに昇華します。*');

        fields.push({
          name: `🧪 思考の醸造所 (00_Inbox/brewing: ${brewingMemos.length}件)`,
          value: brewLines.join('\n')
        });
      }

      // 4. Inboxの直近状況（成熟した思考ログ）
      if (inboxMemos.length > 0) {
        const memoList = inboxMemos.slice(0, 5).map(m => `• \`${m.name}\` (${m.ageDays}日前)`).join('\n');
        fields.push({
          name: `📥 直近の思考メモ (00_Inbox: ${inboxMemos.length}件中)`,
          value: memoList
        });
      }

      const hasAlerts = stalledTasks.length > 0 || expiredMemos.length > 0 || scheduleAlerts.length > 0 || stalledBrewing.length > 0;
      const embed = new EmbedBuilder()
        .setTitle('🧭 COO Morning Operation Brief')
        .setDescription('本日の制作状況および滞留ボトルネックの確認です。')
        .setColor(hasAlerts ? 0xd97706 : (readyToSublimate.length > 0 ? 0x10b981 : 0x2b2d31))
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
 

