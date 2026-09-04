require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const { fetchProductResearch } = require('./researcher');

const VAULT_ROOT_DIR = '/home/tnuma/my-vault';
const RESEARCH_DIR = path.join(VAULT_ROOT_DIR, '01_Projects/Nanshindo_SNS');
const CHECK_INTERVAL_MS = 60 * 1000; // 1分ごとにチェック

// ファイル名・コミットメッセージ用の安全な文字列化
function sanitizeFilename(name) {
    return name
        .replace(/[\\/:*?"<>|]/g, '_')   // スラッシュや禁止文字を _ に変換
        .replace(/\s+/g, '_')            // 空白を _ に変換
        .replace(/_+/g, '_')             // 連続する _ を統合
        .replace(/^[._]+|[._]+$/g, '')   // 先頭・末尾の記号を除去
        .substring(0, 80);               // 長すぎる場合の安全カット
}

// Markdown本文から正式なタイトルを抽出
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

async function runGit(command) {
    return await execPromise(`cd "${VAULT_ROOT_DIR}" && ${command}`);
}

async function checkAndProcessQueue() {
    try {
        // 1. 最新の変更を取得
        await runGit('git pull --rebase origin main');

        // 2. ディレクトリ内のMarkdownファイルを確認
        await fs.mkdir(RESEARCH_DIR, { recursive: true });
        const files = await fs.readdir(RESEARCH_DIR);

        for (const file of files) {
            if (!file.endsWith('.md')) continue;

            const filepath = path.join(RESEARCH_DIR, file);
            const content = await fs.readFile(filepath, 'utf8');

            // 中身が空（または50文字未満のメモ程度）のファイルを「未処理」と判定
            if (content.trim().length < 50) {
                const rawName = path.basename(file, '.md');
                console.log(`[Watcher] 🔍 未処理ファイルを検知: ${rawName}`);

                // 3. リサーチ実行
                const markdownContent = await fetchProductResearch(rawName);

                // 4. 正式名称のファイル名を抽出してリネーム・書き込み
                const cleanTitle = extractFilenameFromMarkdown(markdownContent, rawName);
                const newFilepath = path.join(RESEARCH_DIR, `${cleanTitle}.md`);

                // ファイル名が変わる場合は元の空ファイルを削除
                if (newFilepath !== filepath) {
                    await fs.unlink(filepath);
                }

                await fs.writeFile(newFilepath, markdownContent, 'utf8');
                console.log(`[Watcher] 📝 リサーチ完了: ${cleanTitle}.md`);

                // 5. Git Commit & Push
                const safeMsg = cleanTitle.replace(/"/g, '\\"');
                await runGit(`git add . && git commit -m "Auto-research: ${safeMsg}" && git push origin main`);
                console.log(`[Watcher] 🚀 GitHubへ同期完了: ${cleanTitle}`);
            }
        }
    } catch (error) {
        console.error('[Watcher Error]:', error.message);
    }
}

// 起動時に初回実行し、以降は定期実行
console.log('👀 Vault Watcher is running...');
checkAndProcessQueue();
setInterval(checkAndProcessQueue, CHECK_INTERVAL_MS);