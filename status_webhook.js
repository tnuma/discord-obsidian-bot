// status_webhook.js (状況テキスト抽出の精度向上版)
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const Parser = require('rss-parser');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const parser = new Parser();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const RSS_URL = 'https://status.claude.com/history.rss';
const CHECK_INTERVAL = 5 * 60 * 1000;

let lastPubDate = null;

client.once('ready', async () => {
  console.log(`🤖 Bot Ready: ${client.user.tag}`);
  await checkClaudeStatus(true);
  setInterval(() => checkClaudeStatus(false), CHECK_INTERVAL);
});

// 本文から状態と有効なメッセージをきれいに抜粋する関数
function parseIncidentDetails(content) {
  if (!content) return { status: 'Unknown', models: '詳細情報なし', summary: '詳細を確認してください。' };

  let currentStatus = 'Active Incident';
  let affectedModels = '影響モデル情報なし';
  
  const lower = content.toLowerCase();
  if (lower.includes('identified')) currentStatus = '🔍 原因特定・対応中 (Identified)';
  else if (lower.includes('investigating')) currentStatus = '🔎 調査中 (Investigating)';
  else if (lower.includes('update')) currentStatus = '🔄 状況更新 (Update)';
  else if (lower.includes('resolved')) currentStatus = '✅ 復旧完了 (Resolved)';

  // モデル名の抽出
  const modelKeywords = ['Mythos', 'Fable', 'Opus', 'Sonnet', 'Haiku'];
  const foundModels = modelKeywords.filter(m => content.toLowerCase().includes(m.toLowerCase()));
  if (foundModels.length > 0) {
    affectedModels = foundModels.join(', ') + ' 系モデル';
  }

  // 日付やタイムスタンプ行を除外し、実際のメッセージ本文と思われる最も長い行、または最初の意味のある行を抽出
  const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let summaryText = '詳細データなし';

  for (const line of lines) {
    // "Sep 3, 13:50 UTC" のような日時だけの行や、短すぎる行はスキップする
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2},\s+\d{2}:\d{2}\s+utc/i.test(line)) {
      continue;
    }
    if (line.length > 10) {
      summaryText = line;
      break;
    }
  }
  // もし適切な行が見つからなければ最初の行を使う
  if (summaryText === '詳細データなし' && lines.length > 0) {
    summaryText = lines[0];
  }

  return {
    status: currentStatus,
    models: affectedModels,
    summary: summaryText
  };
}

async function checkClaudeStatus(isInitialRun = false) {
  try {
    const feed = await parser.parseURL(RSS_URL);
    if (feed.items.length === 0) return;

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) return;

    const latest = feed.items[0];
    const pubDate = new Date(latest.pubDate);

    if (isInitialRun) {
      lastPubDate = pubDate;
      const info = parseIncidentDetails(latest.contentSnippet);

      const embed = new EmbedBuilder()
        .setTitle(`🛡️ COO Monitor: Claude 障害ステータス`)
        .setDescription(`**${latest.title}**`)
        .setColor(0xe67e22)
        .addFields(
          { name: '📌 現在のステータス', value: info.status, inline: true },
          { name: '🎯 影響のある系統', value: info.models, inline: true },
          { name: '📝 最新の状況', value: info.summary },
          { name: '🔗 公式リンク', value: `[ステータス詳細ページ](${latest.link})` }
        )
        .setTimestamp(pubDate)
        .setFooter({ text: 'Anthropic RSS Monitor (Startup Parsed)' });

      await channel.send({ embeds: [embed] });
      return;
    }

    // 通常巡回
    if (pubDate > lastPubDate) {
      lastPubDate = pubDate;
      const info = parseIncidentDetails(latest.contentSnippet);

      const embed = new EmbedBuilder()
        .setTitle(`🚨 Claude 障害情報が更新されました`)
        .setDescription(`**${latest.title}**`)
        .setColor(0xe74c3c)
        .addFields(
          { name: '📌 ステータス', value: info.status, inline: true },
          { name: '🎯 影響系統', value: info.models, inline: true },
          { name: '📝 最新の状況', value: info.summary },
          { name: '🔗 公式リンク', value: `[詳細を確認する](${latest.link})` }
        )
        .setTimestamp(pubDate)
        .setFooter({ text: 'Anthropic RSS Monitor' });

      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('RSS巡回エラー:', err.message);
  }
}

client.login(TOKEN);