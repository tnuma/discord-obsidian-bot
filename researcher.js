require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ==========================================
// 1. 文房具・ショート動画リサーチ用
// ==========================================
const systemPromptResearch = `
あなたは事務用品・文房具の専門EC/実店舗「南信堂」のショート動画企画者です。
使い手のリアルな味方として地味な使いにくさやズボラな摩擦を言語化してください。
3層の摩擦分析・情景描写・台本・ショットリスト・スペック表・参考元URLを網羅してください。
※出力はMarkdownのみとし、コードブロック記号（\`\`\`markdown）は含めないでください。
`;

const userPromptTemplateResearch = `
以下の商品についてリサーチし、プレプロダクションシートを作成してください。

対象商品: {{PRODUCT_NAME}}

---
title: "{{正式な商品名・ブランド名}}"
type: short-video-research
date: {{TODAY}}
status: drafting
status_since: {{TODAY}}
channel: Nanshindo_SNS
tags:
  - nanshindo/short-video
  - research
---

# {{正式な商品名・ブランド名}}

## 1. 3秒フック案（逆説・あるあるの違和感）
## 2. 3つのレイヤーで紐解く「名もなき摩擦の解消」
### (1) ジャンル自体の根本的な摩擦
### (2) 同シリーズ・旧型品との比較
### (3) 他社競合・一般的な製品との比較
## 3. この道具を迎えた後の「静かな日常の変化（情景描写）」
## 4. ナレーション台本
## 5. 撮影ショットリスト
## 6. SNS投稿用メタデータ
## 7. 基本スペック・市場価格
## 8. リサーチ参考元（URL必須）
`;

// ==========================================
// 2. メモ自動判別（思考 / クリエイティブ研究 / タスク備忘録）
// ==========================================
const systemPromptMemoRouter = `
あなたは知的生産とクリエイティブ研究を支援する「ナレッジアーキテクト」です。
ユーザーから送られたメモの性質を以下の【3つの型】から自動判定し、最適なMarkdownフォーマットで出力してください。

【3つの型】
①【思考・人間観察・欲望分析（thought-asset）】
日常の違和感、心理摩擦、文化的葛藤、フェティシズムや欲望の言語化。
→ 構造化、二項対立、思想・文化史の潮流、問い、おすすめ文献2冊（新書＋名著）

②【クリエイティブ・動画・演出研究（creative-study）】
動画リンク、SNS投稿、広告、デザイン、表現技法の工夫に対するメモ。
→ 演出・技法の分解、南信堂ショート動画/発信への転用アイデア、検証ポイント

③【シンプル備忘録・タスク（quick-note）】
純粋な作業タスク、買い物リスト、事実のみの短い記録（分析不要なもの）。
→ チェックリスト（ToDo）、要約

【広域バックリンク（[[Wikilink]]）の選定ルール】
- 細かすぎる単発リンク（例: [[バスの席]]）は禁止。他ノートでも何度も使える「一段抽象度の高い中〜広めの概念」（例: [[コミュニケーションコスト]], [[儀礼的無関心]], [[ショート動画演出]], [[聴覚フック]]）にすること。
- 提供された「既存リンク一覧」に意味が近いものがあれば、表記揺れを防ぐため必ず既存の文字列をそのまま再利用すること。
- 関連リンクは YAML frontmatter の related に配列で 2〜4 個格納すること。

※出力はMarkdownのみとし、コードブロック記号（\`\`\`markdown）は含めないでください。
`;

const userPromptTemplateMemo = `
【既存の概念リンク一覧（可能な限りここから再利用）】
{{EXISTING_CONCEPTS}}

【入力メモ】
{{RAW_MEMO}}

---

【出力形式の指定】
※入力内容に応じて以下のいずれかの型を自動選択して出力してください。

▼ ① 思考・人間観察・欲望分析の場合:
---
title: "{{本質を突いた15文字以内のタイトル}}"
date: {{NOW}}
type: thought-log
tags:
  - thought-asset
related:
  - "[[広めの概念1]]"
  - "[[広めの概念2]]"
---

# {{タイトル}}

## 📝 生ログ
> {{RAW_MEMO_QUOTED}}

---

## 🔍 思考の構造化
- **観測された現象:** 
- **水面下の力学・心理:** （[[広めの概念]] を交えて解説）
- **対比・二項対立:** 

## 🏛️ 思想・文化史の潮流（知の系譜）
- （この思考が合流する社会学・心理学・思想史の潮流を解説）

## 💡 他領域への越境
- （創作、人間関係、カルチャー、道具選び等へのアナロジー）

## 🧠 思考を深める3つの問い
1. 
2. 
3. 

## 📚 おすすめ文献（2冊）
### ☕ 気軽に読める1冊（新書・入門書）
- **『書籍名』 著者名（出版社）**
  - **概要と繋がり:** 
  - **リンク:** [書籍情報](URL)

### 📖 深く潜る名著（体系的古典）
- **『書籍名』 著者名（出版社）**
  - **概念と繋がり:** 
  - **リンク:** [書籍情報](URL)

---

▼ ② クリエイティブ・動画・演出研究の場合:
---
title: "{{分析対象と技法を表す15文字以内のタイトル}}"
date: {{NOW}}
type: creative-study
tags:
  - creative/study
related:
  - "[[広めの演出技法1]]"
  - "[[広めの演出技法2]]"
---

# {{タイトル}}

## 🔗 ソース・生ログ
> {{RAW_MEMO_QUOTED}}

---

## 🎬 演出・技法の分解
- **フック設計（0〜2秒）:** 
- **視聴維持・展開のテンポ:** 
- **心理的トリガー:** 

## 💡 南信堂SNS/ショート動画への転用アイデア
- （文具紹介動画やポストへ具体的にどう落とし込めるか）

## 🧪 次に試す検証ポイント
- 

---

▼ ③ シンプル備忘録・タスクの場合:
---
title: "{{用件を表すタイトル}}"
date: {{NOW}}
type: quick-note
tags:
  - memo/todo
---

# {{タイトル}}

## 📋 タスク・要点
- [ ] 
`;

// ==========================================
// 実行関数
// ==========================================
async function fetchProductResearch(productName) {
    const today = new Date().toISOString().split('T')[0];
    const prompt = userPromptTemplateResearch
        .replace('{{PRODUCT_NAME}}', productName)
        .replace(/{{TODAY}}/g, today);

    const response = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: `${systemPromptResearch}\n\n${prompt}`,
        config: { tools: [{ googleSearch: {} }] },
    });

    return response.text;
}

async function analyzeThoughtMemo(rawMemo, existingConcepts = []) {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const quotedMemo = rawMemo.replace(/\n/g, '\n> ');
    const conceptsStr = existingConcepts.length > 0 ? existingConcepts.join(', ') : '（まだ登録がありません）';

    const prompt = userPromptTemplateMemo
        .replace('{{EXISTING_CONCEPTS}}', conceptsStr)
        .replace(/{{RAW_MEMO}}/g, rawMemo)
        .replace('{{RAW_MEMO_QUOTED}}', quotedMemo)
        .replace('{{NOW}}', now);

    const response = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: `${systemPromptMemoRouter}\n\n${prompt}`,
        config: { tools: [{ googleSearch: {} }] },
    });

    return response.text;
}

module.exports = { fetchProductResearch, analyzeThoughtMemo };