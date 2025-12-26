// main.mjs
import fs from "fs";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";

dotenv.config();

// ====================================
// 設定と永続化
// ====================================
const STATUS_STORE = path.resolve(process.cwd(), "timeoutStatus.json");
function saveStatusMessageId(id) {
  try {
    fs.writeFileSync(STATUS_STORE, JSON.stringify({ messageId: id }), "utf8");
  } catch (e) {
    console.log("status save error:", e.message);
  }
}
function loadStatusMessageId() {
  try {
    if (!fs.existsSync(STATUS_STORE)) return null;
    const raw = fs.readFileSync(STATUS_STORE, "utf8");
    const obj = JSON.parse(raw || "{}");
    return obj.messageId || null;
  } catch (e) {
    console.log("status load error:", e.message);
    return null;
  }
}
function clearStatusMessageId() {
  try {
    if (fs.existsSync(STATUS_STORE)) fs.unlinkSync(STATUS_STORE);
  } catch (e) {
    console.log("status clear error:", e.message);
  }
}

// ====================================
// Discord クライアント
// ====================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ====================================
// LOG用チャンネルに埋め込みメッセージ送信
// ====================================
async function sendLog(title, description, color = 0x00ff00, fields = []) {
  const chId = process.env.CHANNEL_ID;
  if (!client.isReady() || !chId) return;

  const ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(() => null);
  if (!ch || !ch.send) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  if (fields.length > 0) {
    embed.addFields(fields);
  }

  ch.send({ embeds: [embed] }).catch(() => {});
}

// ====================================
// AIモデル
// ====================================
const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);

const WHITELIST_USERS = ["harima1945"];
const TIMEOUT_DURATION = 30 * 60 * 1000;
const API_TIMEOUT = 30000;

// 通話参加者へのAI判定設定
let voiceUserAICheck = false;

// AI判定の有効/無効
let aiCheckEnabled = true;

// AI使用頻度制限（連続して同じユーザーを判定しない）
const recentChecks = new Map(); // userId -> timestamp
const AI_CHECK_COOLDOWN = 10000; // 10秒以内は再判定しない

// キーワードフィルター（AI判定が使えない時のバックアップ）
const BAD_KEYWORDS = [
  "死ね", "しね", "殺す", "ころす", "消えろ", "きえろ",
  "クズ", "くず", "ゴミ", "ごみ", "カス", "かす",
  "うざい", "ウザイ", "きもい", "キモイ", "気持ち悪い",
  "バカ", "ばか", "馬鹿", "アホ", "あほ", "阿呆"
];

function simpleKeywordCheck(text) {
  const lowerText = text.toLowerCase();
  for (const keyword of BAD_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      return { isMalicious: true, reason: `禁止ワード「${keyword}」を検出` };
    }
  }
  return { isMalicious: false, reason: "禁止ワードなし" };
}

// レート制限対策
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000;
let requestQueue = Promise.resolve();

// callAPI: 指数バックオフと429/クォータ検出を含む
async function callAPI(apiFunc) {
  return new Promise((resolve, reject) => {
    requestQueue = requestQueue.then(async () => {
      const maxRetries = 5;
      let retries = 0;
      let backoff = 1000;

      while (retries < maxRetries) {
        try {
          const now = Date.now();
          const diff = now - lastRequestTime;
          if (diff < MIN_REQUEST_INTERVAL) {
            await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL - diff));
          }

          lastRequestTime = Date.now();
          console.log("API呼び出し実行中...");

          const r = await Promise.race([
            apiFunc(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("API Timeout")), 15000))
          ]);

          console.log("API呼び出し成功");
          resolve(r);
          return;
        } catch (err) {
          retries++;
          const msg = err && err.message ? err.message : String(err);
          console.log(`API呼び出しエラー (試行 ${retries}/${maxRetries}):`, msg);

          // 429 または Too Many Requests の場合は指数バックオフ
          if (msg.includes("429") || msg.toLowerCase().includes("too many requests")) {
            console.log("レート制限検知 - 指数バックオフ", backoff);
            await new Promise((r) => setTimeout(r, backoff));
            backoff = Math.min(backoff * 2, 30000);

            // ある程度続く場合は上位で処理を切り替えられるようにエラーを返す
            if (retries >= 3) {
              const e = new Error("Rate limit persistent");
              e.code = 429;
              return reject(e);
            }
          } else if (msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("quotaexceeded")) {
            // クォータ超過は即座に失敗扱い
            const e = new Error("Quota exceeded");
            e.code = 403;
            return reject(e);
          } else if (retries >= maxRetries) {
            return reject(err);
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      reject(new Error("API call failed after retries"));
    });
  });
}

// ====================================
// 画像 Base64 変換
// ====================================
async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;

    const ct = res.headers.get("content-type");
    if (ct && ct.includes("image/gif")) {
      console.log("GIFは無視: " + url);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return { inlineData: { data: buf.toString("base64"), mimeType: ct || "image/jpeg" } };
  } catch {
    return null;
  }
}

// ====================================
// AI テキスト判定（使用頻度制限版）
// ====================================
async function checkTextContent(text, userId) {
  if (!aiCheckEnabled) {
    console.log("⚠️ AI判定は無効化されています - キーワードフィルターを使用");
    const keywordResult = simpleKeywordCheck(text);

    sendLog(
      keywordResult.isMalicious ? "🚨 キーワードフィルター検出" : "✅ キーワードフィルター: 安全",
      `メッセージ: \`${text}\``,
      keywordResult.isMalicious ? 0xff0000 : 0x00ff00,
      [
        { name: "判定結果", value: keywordResult.isMalicious ? "❌ 悪質" : "✅ 安全", inline: true },
        { name: "理由", value: keywordResult.reason, inline: false },
        { name: "判定方法", value: "キーワードフィルター（AIバックアップ）", inline: true },
      ]
    );

    return keywordResult;
  }

  const now = Date.now();
  const lastCheck = recentChecks.get(userId);
  if (lastCheck && now - lastCheck < AI_CHECK_COOLDOWN) {
    const remainingCooldown = Math.ceil((AI_CHECK_COOLDOWN - (now - lastCheck)) / 1000);
    console.log(`⏳ ユーザー ${userId} はクールダウン中（残り${remainingCooldown}秒）- AI判定スキップ`);
    return { isMalicious: false, reason: `クールダウン中（${remainingCooldown}秒）`, skipped: true };
  }

  try {
    console.log("=== AI判定開始 ===");
    console.log("入力テキスト:", text);
    console.log("ユーザーID:", userId);

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.1,
      }
    });

    const prompt = `
不適切なメッセージを検出してください。

悪質: 暴力・侮辱・差別・脅迫
安全: 日常会話・質問・絵文字

必ず以下の形式のみで回答:
判定: 悪質
理由: 暴力的表現が含まれている

または
判定: 安全
理由: 日常的な会話である

メッセージ: """${text}"""
    `;

    console.log("Gemini APIに送信中...");
    const startTime = Date.now();

    const result = await callAPI(() => model.generateContent(prompt));

    const elapsedTime = Date.now() - startTime;
    console.log(`API応答時間: ${elapsedTime}ms`);

    const rep = result.response.text().trim();

    console.log("AIの生の回答:", rep);
    console.log("================");

    const isMalicious = rep.includes("判定: 悪質");

    let reason = "判定理由不明";
    const reasonMatch = rep.match(/理由:\s*(.+)/);
    if (reasonMatch) {
      reason = reasonMatch[1].trim().substring(0, 100);
    }

    console.log(`最終判定: ${isMalicious ? "悪質" : "安全"}`);
    console.log(`理由: ${reason}`);

    recentChecks.set(userId, now);

    sendLog(
      isMalicious ? "🚨 AI判定: 悪質メッセージ検出" : "✅ AI判定: 安全メッセージ",
      `メッセージ: \`${text}\``,
      isMalicious ? 0xff0000 : 0x00ff00,
      [
        { name: "判定結果", value: isMalicious ? "❌ 悪質" : "✅ 安全", inline: true },
        { name: "理由", value: reason, inline: false },
        { name: "処理時間", value: `${elapsedTime}ms`, inline: true },
        { name: "ユーザーID", value: userId, inline: true },
        { name: "AIの回答", value: `\`\`\`${rep.substring(0, 500)}\`\`\``, inline: false },
      ]
    );

    return { isMalicious, reason, fullResponse: rep, skipped: false };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.log("❌ AI判定エラー:", msg);

    // 429 や Rate limit persistent を検出したら AI を一時無効化してログ通知
    if (err.code === 429 || msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("quota")) {
      aiCheckEnabled = false;
      sendLog("⚠️ AI API レート/クォータ問題", "AI 判定を一時無効化しました。クォータと請求を確認してください。", 0xffa500);
      return simpleKeywordCheck(text);
    }

    // その他はキーワード判定にフォールバック
    return simpleKeywordCheck(text);
  }
}

// ====================================
// AI 画像判定
// ====================================
async function checkImageContent(img) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
画像に明らかに不適切な内容（暴力・性的・差別など）があれば「悪質」と判定してください。
一般的な画像や日常的な内容は「安全」と判定してください。

必ず以下のフォーマットで回答してください：
判定: [悪質 または 安全]
理由: [30文字以内の簡潔な理由]
    `;
    const result = await callAPI(() => model.generateContent([prompt, img]));
    const rep = result.response.text().trim();

    const isMalicious = rep.includes("判定: 悪質");

    let reason = "判定理由不明";
    const reasonMatch = rep.match(/理由:\s*(.+)/);
    if (reasonMatch) {
      reason = reasonMatch[1].trim().substring(0, 50);
    }

    return { isMalicious, reason, fullResponse: rep };
  } catch (err) {
    return { isMalicious: false, reason: "判定エラー", fullResponse: err.message };
  }
}

// ====================================
// Timeout残秒取得（0秒以下は除外）
// ====================================
function getTimeoutRemaining(member) {
  const end = member.communicationDisabledUntilTimestamp ?? 0;
  const now = Date.now();
  const remain = Math.ceil((end - now) / 1000);
  return remain > 0 ? remain : null;
}

// ====================================
// 時間をフォーマット
// ====================================
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// ====================================
// リアルタイム Timeout 更新（永続化対応）
// ====================================
let timeoutStatusMessage = null;
let updateInterval = null;
const TIMEOUT_STATUS_CHANNEL = process.env.TIMEOUT_CHANNEL;

// 大規模サーバー対策: フェッチ間隔とバックオフ設定
const FULL_FETCH_INTERVAL = 60000; // 60秒（必要に応じて延長）
let lastFullFetch = 0;
let fetchBackoff = 2000; // 初回バックオフ 2秒
const MAX_FETCH_BACKOFF = 60000; // 最大 60秒

async function ensureTimeoutStatusMessage(ch) {
  const savedId = loadStatusMessageId();
  if (savedId) {
    try {
      const msg = await ch.messages.fetch(savedId).catch(() => null);
      if (msg) return msg;
      clearStatusMessageId();
    } catch (e) {
      console.log("メッセージ復元エラー:", e.message);
    }
  }

  const newMsg = await ch.send("⏳ **Timeout 監視を開始します...**");
  saveStatusMessageId(newMsg.id);
  return newMsg;
}

async function updateRealtimeTimeout() {
  if (!TIMEOUT_STATUS_CHANNEL) {
    console.log("⚠️ TIMEOUT_CHANNEL が設定されていません");
    return;
  }

  try {
    const ch = await client.channels.fetch(TIMEOUT_STATUS_CHANNEL).catch(() => null);
    if (!ch || !ch.guild) {
      console.log("⚠️ タイムアウト表示チャンネルが見つかりません");
      return;
    }

    const guild = ch.guild;

    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }

    timeoutStatusMessage = await ensureTimeoutStatusMessage(ch);
    console.log("✅ リアルタイムタイムアウト表示を開始しました (messageId:", timeoutStatusMessage.id, ")");

    let lastEditTime = 0;
    let editQueue = Promise.resolve();

    updateInterval = setInterval(async () => {
      try {
        const now = Date.now();

        // フェッチは頻繁に行わない。成功時にバックオフをリセット、失敗時は指数的に待機
        if (now - lastFullFetch > FULL_FETCH_INTERVAL) {
          try {
            // withPresences: false で軽めに試す
            await guild.members.fetch({ withPresences: false }).catch(() => null);
            lastFullFetch = now;
            fetchBackoff = 2000; // 成功したらバックオフをリセット
          } catch (e) {
            console.log("guild.members.fetch error:", e.code || e.message);

            // タイムアウト系のエラーを検出してバックオフを伸ばす
            if (e.name === "GuildMembersTimeout" || (e.message && e.message.includes("GuildMembersTimeout"))) {
              console.log("GuildMembersTimeout を検出しました。バックオフを適用します:", fetchBackoff);
              await new Promise(r => setTimeout(r, fetchBackoff));
              fetchBackoff = Math.min(fetchBackoff * 2, MAX_FETCH_BACKOFF);
              // lastFullFetch は更新しない（次ループで再試行）
            } else {
              // その他のエラーは短く待って次回に
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        }

        // タイムアウト中のユーザーをキャッシュから取得（全件フェッチが失敗してもキャッシュで表示）
        const timeoutUsers = guild.members.cache
          .map((m) => ({ member: m, remain: getTimeoutRemaining(m) }))
          .filter((x) => x.remain !== null)
          .sort((a, b) => b.remain - a.remain);

        const currentTimestamp = Math.floor(Date.now() / 1000);

        let text;
        if (timeoutUsers.length === 0) {
          text = "✅ **現在タイムアウト中のユーザーはいません**\n\n最終更新: <t:" + currentTimestamp + ":T>";
        } else {
          text = `⏳ **タイムアウト中のユーザー一覧** (${timeoutUsers.length}人)\n\n`;
          text += timeoutUsers
            .map((u, i) => {
              const bar = "█".repeat(Math.max(1, Math.floor(u.remain / 60)));
              return `${i + 1}. **${u.member.user.tag}**\n   残り: ${formatTime(u.remain)} ${bar}`;
            })
            .join("\n\n");
          text += "\n\n最終更新: <t:" + currentTimestamp + ":T>";
        }

        if (!timeoutStatusMessage) {
          console.log("⚠️ メッセージがnullのため再作成します");
          timeoutStatusMessage = await ensureTimeoutStatusMessage(ch);
        }

        if (timeoutStatusMessage && timeoutStatusMessage.content !== text) {
          editQueue = editQueue.then(async () => {
            if (!timeoutStatusMessage) return;

            const timeSinceLastEdit = Date.now() - lastEditTime;
            if (timeSinceLastEdit < 700) {
              await new Promise(r => setTimeout(r, 700 - timeSinceLastEdit));
            }

            try {
              await timeoutStatusMessage.edit(text);
              lastEditTime = Date.now();
            } catch (err) {
              console.log("メッセージ編集エラー:", err.code || err.message);
              if (err.code === 10008 || (err.message && err.message.includes("Unknown Message"))) {
                timeoutStatusMessage = null;
                clearStatusMessageId();
              } else if (err.code === 50013) {
                console.log("権限エラー: Botにメッセージ編集権限があるか確認してください");
              } else if (err.code === 429) {
                console.log("⚠️ レート制限検知 - 5秒待機");
                await new Promise(r => setTimeout(r, 5000));
              } else {
                console.log("編集失敗詳細:", err);
              }
            }
          }).catch(e => console.log("editQueue error:", e.message));
        }
      } catch (err) {
        console.log("リアルタイム更新失敗:", err.code || err.message);
      }
    }, 1000);

  } catch (err) {
    console.log("リアルタイム表示の初期化エラー:", err.message);
  }
}

// ====================================
// メッセージ監視
// ====================================
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    if (WHITELIST_USERS.includes(message.author.username)) return;

    const member = message.guild.members.cache.get(message.author.id);
    const isInVoice = member?.voice?.channel !== null;

    if (isInVoice && !voiceUserAICheck) {
      console.log(`通話中のユーザー ${message.author.username} のメッセージをスキップ (AI判定OFF)`);
      return;
    }

    let malicious = false;
    let reasons = [];
    let detectedContent = [];

    if (message.content.trim().length > 0) {
      console.log(`\n===== メッセージ判定 =====`);
      console.log(`ユーザー: ${message.author.username}`);
      console.log(`内容: "${message.content}"`);
      console.log(`文字数: ${message.content.length}`);

      const result = await checkTextContent(message.content, message.author.id);

      if (result.skipped) {
        console.log(`⏭️ AI判定スキップ: ${result.reason}`);
        console.log(`========================\n`);
        return;
      }

      console.log(`判定完了: ${result.isMalicious ? "⛔ 悪質" : "✅ 安全"}`);
      console.log(`理由: ${result.reason}`);
      console.log(`========================\n`);

      if (result.isMalicious) {
        malicious = true;
        reasons.push(`📝 テキスト: ${result.reason}`);
        detectedContent.push({
          type: "テキスト",
          content: message.content.substring(0, 100) + (message.content.length > 100 ? "..." : ""),
          reason: result.reason,
        });
      }
    }

    for (const a of message.attachments.values()) {
      if (!a.contentType?.startsWith("image/")) continue;

      const img = await fetchImageAsBase64(a.url);
      if (img) {
        const result = await checkImageContent(img);
        if (result.isMalicious) {
          malicious = true;
          reasons.push(`🖼️ 画像: ${result.reason}`);
          detectedContent.push({
            type: "画像",
            content: a.url,
            reason: result.reason,
          });
        }
      }
    }

    if (malicious) {
      const member = await message.guild.members.fetch(message.author.id);
      await member.timeout(TIMEOUT_DURATION);

      await message.guild.members.fetch({ force: true }).catch(() => {});

      message.channel.send(`⛔ **${message.author.username}** を timeout しました (${TIMEOUT_DURATION / 1000 / 60}分)`);
      console.log(`AUTO TIMEOUT → ${message.author.username} | 理由: ${reasons.join(", ")}`);

      const fields = [
        { name: "👤 対象ユーザー", value: `${message.author.tag} (${message.author.id})`, inline: false },
        { name: "⏱️ タイムアウト期間", value: formatTime(TIMEOUT_DURATION / 1000), inline: true },
        { name: "📍 チャンネル", value: `<#${message.channel.id}>`, inline: true },
        { name: "🚨 検出理由", value: reasons.join("\n"), inline: false },
      ];

      if (detectedContent.length > 0) {
        detectedContent.forEach((item, i) => {
          if (item.type === "テキスト") {
            fields.push({
              name: `📝 検出内容 ${i + 1}`,
              value: `\`\`\`${item.content}\`\`\`\n理由: ${item.reason}`,
              inline: false,
            });
          } else if (item.type === "画像") {
            fields.push({
              name: `🖼️ 検出内容 ${i + 1}`,
              value: `[画像リンク](${item.content})\n理由: ${item.reason}`,
              inline: false,
            });
          }
        });
      }

      sendLog(
        "🔨 自動タイムアウト実行",
        `**${message.author.username}** がAIによって自動的にタイムアウトされました`,
        0xff0000,
        fields
      );
    }
  } catch (err) {
    console.log("messageCreate handler error:", err && (err.stack || err.message));
  }
});

// ====================================
// Slash Commands 定義
// ====================================
const slashCommands = [
  new SlashCommandBuilder()
    .setName("top")
    .setDescription("指定ユーザーを timeout（管理者専用）")
    .addUserOption((o) => o.setName("user").setDescription("対象ユーザー").setRequired(true))
    .addIntegerOption((o) => o.setName("seconds").setDescription("秒数").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("to")
    .setDescription("現在 timeout 中のユーザー一覧"),

  new SlashCommandBuilder()
    .setName("voice-ai")
    .setDescription("通話参加者へのAI判定設定（管理者専用）")
    .addStringOption((o) =>
      o.setName("mode")
        .setDescription("ON/OFF")
        .setRequired(true)
        .addChoices(
          { name: "ON - 通話中のユーザーもAI判定する", value: "on" },
          { name: "OFF - 通話中のユーザーはAI判定しない", value: "off" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("ai-mode")
    .setDescription("AI判定のON/OFF（管理者専用）")
    .addStringOption((o) =>
      o.setName("mode")
        .setDescription("ON/OFF")
        .setRequired(true)
        .addChoices(
          { name: "ON - AI判定を有効化", value: "on" },
          { name: "OFF - キーワードフィルターのみ", value: "off" }
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

// ====================================
// ready
// ====================================
client.once("ready", async () => {
  console.log(`Bot login → ${client.user.tag}`);
  await sendLog(
    "✅ Bot起動完了",
    `**${client.user.tag}** がオンラインになりました`,
    0x00ff00
  );
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log("Slash Commands Registered");
  } catch (e) {
    console.log("Slash command register error:", e && e.message);
  }

  // 一度だけ開始（多重起動防止）
  setTimeout(() => {
    if (!updateInterval) updateRealtimeTimeout();
  }, 2000);
});

// ====================================
// Slash コマンド処理
// ====================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guild = interaction.guild;

  if (interaction.commandName === "top") {
    try {
      console.log("TOP コマンド実行開始");

      await interaction.deferReply();

      const user = interaction.options.getUser("user");
      const sec = interaction.options.getInteger("seconds");

      const MAX_TIMEOUT = 2419200;
      if (sec > MAX_TIMEOUT) {
        await interaction.editReply(`❌ タイムアウトは最大28日（2,419,200秒）までです。\n指定された秒数: ${sec}秒`);
        return;
      }

      if (sec < 1) {
        await interaction.editReply(`❌ タイムアウトは1秒以上で指定してください。`);
        return;
      }

      const member = await guild.members.fetch(user.id);
      await member.timeout(sec * 1000, "管理者による手動timeout");

      await interaction.editReply(`⛔ 管理者が **${user.tag}** を ${sec} 秒 (${formatTime(sec)}) timeout しました`);

      guild.members.fetch({ force: true }).catch(() => {});

      sendLog(
        "⚖️ 管理者による手動タイムアウト",
        `**${interaction.user.tag}** が **${user.tag}** をタイムアウトしました`,
        0xffa500,
        [
          { name: "👤 対象ユーザー", value: `${user.tag} (${user.id})`, inline: false },
          { name: "👮 実行管理者", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
          { name: "⏱️ タイムアウト期間", value: formatTime(sec), inline: true },
          { name: "📍 実行チャンネル", value: `<#${interaction.channel.id}>`, inline: true },
        ]
      );

      console.log(`MANUAL TIMEOUT → ${user.tag} by ${interaction.user.tag}`);
    } catch (err) {
      console.log("TOP コマンドエラー:", err && (err.message || err));
      await interaction.editReply(`❌ エラーが発生しました: ${err.message}`).catch(() => {
        interaction.reply(`❌ エラーが発生しました: ${err.message}`).catch(() => {});
      });
    }
    return;
  }

  if (interaction.commandName === "to") {
    try {
      const timeoutUsers = guild.members.cache
        .map((m) => ({ member: m, remain: getTimeoutRemaining(m) }))
        .filter((x) => x.remain !== null)
        .sort((a, b) => b.remain - a.remain);

      if (timeoutUsers.length === 0)
        return interaction.reply("✅ timeout 中のユーザーはいません");

      const msg =
        `⏳ **Timeout 中のユーザー一覧** (${timeoutUsers.length}人)\n\n` +
        timeoutUsers.map((u, i) => `${i + 1}. **${u.member.user.tag}** ・残り ${formatTime(u.remain)}`).join("\n");

      interaction.reply(msg);
    } catch (err) {
      console.log("TO コマンドエラー:", err.message);
      interaction.reply("❌ エラーが発生しました").catch(() => {});
    }
  }

  if (interaction.commandName === "voice-ai") {
    try {
      const mode = interaction.options.getString("mode");
      voiceUserAICheck = mode === "on";

      const status = voiceUserAICheck ? "✅ **有効**" : "❌ **無効**";
      const emoji = voiceUserAICheck ? "🔊" : "🔇";

      sendLog(
        `${emoji} 通話参加者AI判定設定変更`,
        `**${interaction.user.tag}** が通話参加者へのAI判定を${voiceUserAICheck ? "有効化" : "無効化"}しました`,
        voiceUserAICheck ? 0x00ff00 : 0xff0000,
        [
          { name: "👮 実行管理者", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
          { name: "⚙️ 新しい設定", value: status, inline: true },
        ]
      );

      interaction.reply({
        content: `${emoji} 通話参加者へのAI判定を ${status} にしました\n\n` +
                 `通話中のユーザーのメッセージは${voiceUserAICheck ? "AI判定されます" : "AI判定されません"}`,
        ephemeral: false
      });

      console.log(`VOICE AI CHECK → ${voiceUserAICheck ? "ON" : "OFF"} by ${interaction.user.tag}`);
    } catch (err) {
      console.log("VOICE-AI コマンドエラー:", err.message);
      interaction.reply("❌ エラーが発生しました").catch(() => {});
    }
  }

  if (interaction.commandName === "ai-mode") {
    try {
      const mode = interaction.options.getString("mode");
      aiCheckEnabled = mode === "on";

      const status = aiCheckEnabled ? "✅ **AI判定有効**" : "⚠️ **キーワードフィルターのみ**";
      const emoji = aiCheckEnabled ? "🤖" : "📝";

      sendLog(
        `${emoji} AI判定モード変更`,
        `**${interaction.user.tag}** がAI判定を${aiCheckEnabled ? "有効化" : "無効化"}しました`,
        aiCheckEnabled ? 0x00ff00 : 0xffa500,
        [
          { name: "👮 実行管理者", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
          { name: "⚙️ 新しい設定", value: status, inline: true },
        ]
      );

      interaction.reply({
        content: `${emoji} AI判定モードを ${status} にしました\n\n` +
                 (aiCheckEnabled
                   ? "Gemini AIで判定します（高精度）"
                   : "キーワードフィルターで動作します（APIクォータ節約）"),
        ephemeral: false
      });

      console.log(`AI MODE → ${aiCheckEnabled ? "ON" : "OFF"} by ${interaction.user.tag}`);
    } catch (err) {
      console.log("AI-MODE コマンドエラー:", err.message);
      interaction.reply("❌ エラーが発生しました").catch(() => {});
    }
  }
});

// ====================================
// エラーハンドリング
// ====================================
client.on("error", (error) => {
  console.log("Discord Client Error:", error && (error.message || error));
  sendLog("❌ Bot エラー", error && (error.message || String(error)), 0xff0000);
});

process.on("unhandledRejection", (error) => {
  console.log("Unhandled Rejection:", error && (error.stack || error));
});

process.on("uncaughtException", (err) => {
  console.log("Uncaught Exception:", err && (err.stack || err));
  // Render はプロセスを再起動するため、ここではログを残すのみ
});

// Graceful shutdown for Render
process.on("SIGTERM", async () => {
  console.log("SIGTERM received: shutting down gracefully");
  try {
    if (updateInterval) clearInterval(updateInterval);
    await sendLog("⚠️ Bot 停止", "プロセスが停止シグナルを受け取りました", 0xffa500);
  } catch (e) {
    console.log("shutdown error:", e && e.message);
  } finally {
    process.exit(0);
  }
});

// ====================================
// Bot 起動
// ====================================
console.log("Discord 接続中…");
client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.log("Discord login failed:", e && e.message);
});

// ====================================
// Web サーバー（Render対策）
// ====================================
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.json({ status: "Bot is running!", uptime: process.uptime(), now: new Date().toISOString() });
});
app.listen(port, () => {
  console.log(`Web server listening on port ${port}`);
});