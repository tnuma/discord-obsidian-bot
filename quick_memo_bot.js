const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

// ==========================================
// ⚙️ 設定エリア
// ==========================================
const TOKEN = 'MTU0MzQzMDU3OTYzNzMyNTg4NA.GQ7FDX.9fLA6WtSthpoPaN4y3HXfk5Y4NZfxb-GfrV8-M';
const CHANNEL_ID = '1543418617528455259'; // チャンネルID（文字列として設定してください）
// ラズパイから見たMacのAuto-Memoフォルダのパス
const SAVE_DIR = '/mnt/mac_vault/00_Inbox/Auto-Memo/'; 

// ==========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    // Bot自身のメッセージは無視
    if (message.author.bot) return;

    // #quick-memo チャンネルのみ処理
    if (message.channelId === CHANNEL_ID) {
        const now = new Date();
        
        // ファイル名を日時で生成 (例: 20260830_095121.md)
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        
        const filename = `${year}${month}${day}_${hours}${minutes}${seconds}.md`;
        const filepath = path.join(SAVE_DIR, filename);

        // Markdownファイルのフォーマット (フロントマター付き)
        const dateStr = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        const content = `---\ndate: ${dateStr}\n---\n\n${message.content}\n`;

        try {
            // 保存先ディレクトリが存在しない場合は念のため作成
            await fs.mkdir(SAVE_DIR, { recursive: true });
            
            // ファイル書き込み
            await fs.writeFile(filepath, content, 'utf8');
            
            // 成功したらDiscordのメッセージにチェックマークをつける
            await message.react('✅');
            console.log(`Saved: ${filename}`);
        } catch (error) {
            console.error(`Error saving file: ${error}`);
            await message.react('❌');
        }
    }
});

client.login(TOKEN);