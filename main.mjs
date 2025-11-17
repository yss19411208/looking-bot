// main.mjs
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

  const ch = client.channels.cache.get(chId);
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

// レート制限対策
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000;
let requestQueue = Promise.resolve();

async function callAPI(apiFunc) {
  return new Promise((resolve) => {
    requestQueue = requestQueue.then(async () => {
      while (true) {
        try {
          const now = Date.now();
          const diff = now - lastRequestTime;
          if (diff < MIN_REQUEST_INTERVAL)
            await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL - diff));

          lastRequestTime = Date.now();
          const r = await apiFunc();
          resolve(r);
          return;
        } catch (err) {
          if (err.message.includes("429")) await new Promise((r) => setTimeout(r, 3000));
          else await new Promise((r) => setTimeout(r, 2000));
        }
      }
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
// AI テキスト判定
// ====================================
async function checkTextContent(text) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
あなたは不適切なメッセージを検出するAIです。以下のメッセージを判定してください。

【悪質と判定する基準】
- 暴力的な表現（殺す、死ね、など）
- 差別的な発言
- 脅迫や恐喝
- 性的な嫌がらせ
- 攻撃的な侮辱

【安全と判定する基準】
- 絵文字のみのメッセージ
- 日常会話
- 軽い冗談

必ず以下のフォーマットで回答してください：
判定: 悪質
理由: [30文字以内の具体的な理由]

または

判定: 安全
理由: [理由]

メッセージ:
${text}
    `;
    const result = await callAPI(() => model.generateContent(prompt));
    const rep = result.response.text().trim();
    
    console.log("AI判定結果:", rep);
    
    const isMalicious = rep.includes("判定: 悪質");
    
    // 理由を抽出
    let reason = "判定理由不明";
    const reasonMatch = rep.match(/理由:\s*(.+)/);
    if (reasonMatch) {
      reason = reasonMatch[1].trim().substring(0, 50);
    }
    
    return { isMalicious, reason, fullResponse: rep };
  } catch (err) {
    console.log("AI判定エラー:", err.message);
    return { isMalicious: false, reason: "判定エラー", fullResponse: err.message };
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
    
    // 理由を抽出
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
// リアルタイム Timeout 更新（指定チャンネル）
// ====================================
let timeoutStatusMessage = null;
let updateInterval = null;
const TIMEOUT_STATUS_CHANNEL = process.env.TIMEOUT_CHANNEL;

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

    // 初回メッセージ送信
    if (!timeoutStatusMessage) {
      timeoutStatusMessage = await ch.send("⏳ **Timeout 監視を開始します...**");
      console.log("✅ リアルタイムタイムアウト表示を開始しました");
    }

    // 既存のインターバルをクリア
    if (updateInterval) clearInterval(updateInterval);

    let lastEditTime = 0;
    let lastFullFetch = 0;
    let editQueue = Promise.resolve();
    
    // 1秒ごとに更新
    updateInterval = setInterval(async () => {
      try {
        const now = Date.now();
        
        // 5秒ごとにメンバー情報を強制更新
        if (now - lastFullFetch > 5000) {
          await guild.members.fetch({ force: true }).catch(() => {});
          lastFullFetch = now;
        }
        
        // タイムアウト中のユーザーを取得
        const timeoutUsers = guild.members.cache
          .map((m) => ({ member: m, remain: getTimeoutRemaining(m) }))
          .filter((x) => x.remain !== null)
          .sort((a, b) => b.remain - a.remain); // 残り時間が長い順

        let text;
        if (timeoutUsers.length === 0) {
          text = "✅ **現在タイムアウト中のユーザーはいません**\n\n最終更新: <t:" + Math.floor(Date.now() / 1000) + ":T>";
        } else {
          text = `⏳ **タイムアウト中のユーザー一覧** (${timeoutUsers.length}人)\n\n`;
          text += timeoutUsers
            .map((u, i) => {
              const bar = "█".repeat(Math.max(1, Math.floor(u.remain / 60)));
              return `${i + 1}. **${u.member.user.tag}**\n   残り: ${formatTime(u.remain)} ${bar}`;
            })
            .join("\n\n");
          text += "\n\n最終更新: <t:" + Math.floor(Date.now() / 1000) + ":T>";
        }

        // メッセージが存在しない場合は再作成
        if (!timeoutStatusMessage) {
          console.log("⚠️ メッセージが削除されたため再作成します");
          clearInterval(updateInterval);
          updateRealtimeTimeout();
          return;
        }

        // メッセージを編集（変更がある場合のみ、キューで制御）
        if (timeoutStatusMessage.content !== text) {
          editQueue = editQueue.then(async () => {
            // 編集前に再度nullチェック
            if (!timeoutStatusMessage) {
              console.log("⚠️ 編集時にメッセージがnullです");
              return;
            }

            const timeSinceLastEdit = Date.now() - lastEditTime;
            // レート制限対策：最低500ms空ける
            if (timeSinceLastEdit < 500) {
              await new Promise(r => setTimeout(r, 500 - timeSinceLastEdit));
            }
            
            try {
              await timeoutStatusMessage.edit(text);
              lastEditTime = Date.now();
            } catch (err) {
              console.log("メッセージ編集エラー:", err.message);
              // メッセージが削除された場合は再作成
              if (err.code === 10008 || err.message.includes("Unknown Message")) {
                timeoutStatusMessage = null;
                clearInterval(updateInterval);
                updateRealtimeTimeout();
              }
              // レート制限エラーの場合は少し待つ
              if (err.code === 429) {
                console.log("⚠️ レート制限検知 - 5秒待機");
                await new Promise(r => setTimeout(r, 5000));
              }
            }
          });
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
  if (message.author.bot || !message.guild) return;
  if (WHITELIST_USERS.includes(message.author.username)) return;

  // 通話参加者チェック
  const member = message.guild.members.cache.get(message.author.id);
  const isInVoice = member?.voice?.channel !== null;
  
  // 通話中のユーザーで、voiceUserAICheckがOFFの場合はスキップ
  if (isInVoice && !voiceUserAICheck) {
    console.log(`通話中のユーザー ${message.author.username} のメッセージをスキップ (AI判定OFF)`);
    return;
  }

  let malicious = false;
  let reasons = [];
  let detectedContent = [];

  // テキスト判定
  if (message.content.trim().length > 0) {
    console.log(`メッセージ判定開始: "${message.content}"`);
    const result = await checkTextContent(message.content);
    console.log(`判定結果: ${result.isMalicious ? "悪質" : "安全"} - ${result.reason}`);
    
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

  // 画像判定
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

    // タイムアウト後、メンバー情報を更新
    await message.guild.members.fetch({ force: true }).catch(() => {});

    // チャンネルに即座に通知
    message.channel.send(`⛔ **${message.author.username}** を timeout しました (${TIMEOUT_DURATION / 1000 / 60}分)`);
    console.log(`AUTO TIMEOUT → ${message.author.username} | 理由: ${reasons.join(", ")}`);

    // 詳細ログは非同期でバックグラウンド送信（awaitしない）
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

    // バックグラウンドで送信
    sendLog(
      "🔨 自動タイムアウト実行",
      `**${message.author.username}** がAIによって自動的にタイムアウトされました`,
      0xff0000,
      fields
    );
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
  await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
  console.log("Slash Commands Registered");

  // リアルタイムタイムアウト表示を開始
  setTimeout(() => updateRealtimeTimeout(), 2000);
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
      console.log("TOP コマンドエラー:", err.message, err.code);
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
});

// ====================================
// エラーハンドリング
// ====================================
client.on("error", (error) => {
  console.log("Discord Client Error:", error.message);
  sendLog("❌ Bot エラー", error.message, 0xff0000);
});

process.on("unhandledRejection", (error) => {
  console.log("Unhandled Rejection:", error);
});

// ====================================
// Bot 起動
// ====================================
console.log("Discord 接続中…");
client.login(process.env.DISCORD_TOKEN);

// ====================================
// Web サーバー（Render対策）
// ====================================
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.json({ status: "Bot is running!", uptime: process.uptime(), now: new Date().toISOString() });
});
app.listen(port, () => console.log(`Web OK : ${port}`));