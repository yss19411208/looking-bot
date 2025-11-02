// main.mjs - Discord Botのメインプログラム（AI判定強化版）

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
} from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";

// 環境変数を読み込み
dotenv.config();

// Discordクライアントを作成
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`🎉 ${client.user.tag} が正常に起動しました！`);
  console.log(`📊 ${client.guilds.cache.size} つのサーバーに参加中`);
});

// Gemini初期化
const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);

// 👤 ホワイトリスト（AI判定スキップ）
const WHITELIST_USERS = ["harima1945"];

// ⏱ タイムアウト時間（10分）
const TIMEOUT_DURATION = 10 * 60 * 1000;

// 🔍 Geminiに判定を依頼する関数（テキスト＋画像対応）
async function judgeContent({ text = "", imageUrl = null }) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // ---- 強化版プロンプト ----
    const prompt = `
あなたはDiscordの安全管理AIです。
次の内容（テキストおよび画像）を分析し、以下の基準で判定してください。

【悪質とみなす条件】
- 「死ね」「殺す」「消えろ」などの攻撃的・暴力的・侮辱的表現
- 差別、脅迫、性的、グロテスク、不快、スパム、犯罪助長など
- 自殺・自傷・暴力・犯罪・テロ行為の示唆
- 血液、死体、武器、性的・暴力的な画像、または危険な象徴を含む画像

【安全とみなす条件】
- 教育的・中立的・引用的な文脈であり、害意を含まないもの
- 冗談・ゲーム内の軽い表現・明確に無害な内容

【出力ルール】
- 必ず「悪質」または「安全」のどちらかのみを日本語で返す
- 説明・理由・その他の文章は一切書かない
`;

    const parts = [{ text: prompt }];

    if (text) parts.push({ text });

    if (imageUrl) {
      const imageBuffer = await fetch(imageUrl).then((r) => r.arrayBuffer());
      parts.push({
        inlineData: {
          mimeType: "image/png",
          data: Buffer.from(imageBuffer).toString("base64"),
        },
      });
    }

    const result = await model.generateContent(parts);
    const response = result.response.text().trim();

    // 出力のバリデーション
    if (!["悪質", "安全"].includes(response)) {
      console.warn("⚠️ 不明な判定を検出:", response);
      return "悪質"; // 不明なときは安全側へ倒す
    }

    return response;
  } catch (err) {
    console.error("Gemini判定エラー:", err);
    return "悪質"; // エラー時も安全側へ
  }
}

// 💬 メッセージイベント
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const username = message.author.username;
  const content = message.content;

  // ホワイトリストユーザーは除外
  if (WHITELIST_USERS.includes(username)) return;

  const attachments = message.attachments;
  const hasImage =
    attachments.size > 0 &&
    attachments.first().contentType?.startsWith("image/");

  try {
    let result;

    // 🖼️ 画像＋テキスト判定
    if (hasImage) {
      const imageUrl = attachments.first().url;
      result = await judgeContent({ text: content, imageUrl });
      console.log(`[Gemini画像+テキスト判定] ${username}: ${result}`);
    } else {
      // ✉️ テキストのみ判定
      result = await judgeContent({ text: content });
      console.log(`[Geminiテキスト判定] ${username}: ${result}`);
    }

    // 🚫 不適切ならタイムアウト
    if (result.includes("悪質")) {
      const member = await message.guild.members.fetch(message.author.id);
      await member.timeout(TIMEOUT_DURATION, "Geminiによる不適切判定");

      await message.reply(
        `⚠️ **${username}** をタイムアウトしました（理由: 不適切な内容または画像が検出されました）`
      );

      console.log(`⛔ ${username} をタイムアウトしました`);
    }
  } catch (err) {
    console.error("メッセージ処理エラー:", err);
  }
});

// 🧭 Slashコマンド設定 (/send)
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const commands = [
  new SlashCommandBuilder()
    .setName("send")
    .setDescription("指定したユーザーに秘密のメッセージを送る")
    .addUserOption((option) =>
      option.setName("target").setDescription("メッセージを送る相手").setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("message").setDescription("送る内容").setRequired(true)
    ),
].map((command) => command.toJSON());

// Slashコマンド登録
const rest = new REST({ version: "10" }).setToken(TOKEN);
await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

// 📨 DM送信機能
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "send") {
    const target = interaction.options.getUser("target");
    const message = interaction.options.getString("message");

    try {
      await target.send(`📩 **${interaction.user.tag}** からのメッセージ:\n${message}`);
      await interaction.reply({
        content: `✅ ${target.tag} にメッセージを送信しました（DMで）`,
        ephemeral: true,
      });
    } catch (err) {
      console.error("DM送信エラー:", err);
      await interaction.reply({
        content: `❌ ${target.tag} にDMを送信できません（DM拒否設定かも）`,
        ephemeral: true,
      });
    }
  }
});

// ⚠️ エラーハンドリング
client.on("error", (error) => {
  console.error("❌ Discord クライアントエラー:", error);
});

process.on("SIGINT", () => {
  console.log("🛑 Botを終了しています...");
  client.destroy();
  process.exit(0);
});

// Discordログイン処理
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN が .env に設定されていません！");
  process.exit(1);
}

console.log("🔄 Discord に接続中...");
client
  .login(process.env.DISCORD_TOKEN)
  .catch((error) => {
    console.error("❌ ログインに失敗しました:", error);
    process.exit(1);
  });

// 🌐 Render用Expressサーバー
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    status: "Bot is running! 🤖",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.listen(port, () => {
  console.log(`🌐 Web サーバーがポート ${port} で起動しました`);
});
