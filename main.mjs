// main.mjs - Discord Botのメインプログラム（誤判定防止版）

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

// .envファイルから環境変数を読み込み
dotenv.config();

// Discord Botクライアントを作成
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

// Google Gemini AI 初期化
const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);

// 👤 ホワイトリスト（AI判定をスキップ）
const WHITELIST_USERS = ["harima1945"];

// ⏱ タイムアウト時間（10分）
const TIMEOUT_DURATION = 10 * 60 * 1000;

// 🔍 Geminiに判定を依頼する関数（テキスト＋画像対応・誤判定防止版）
async function judgeContent({ text = "", imageUrl = null }) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const prompt = `
あなたはDiscordの安全管理AIです。
次の内容（テキストおよび画像）を分析し、以下の基準で判定してください。

【悪質とみなす条件】
- 「死ね」「殺す」「消えろ」「バカ」「ゴミ」など攻撃的・侮辱的な発言
- 差別、脅迫、性的、グロテスク、不快、スパム、犯罪助長など
- 自殺・自傷・暴力・犯罪・テロ・武器・血液・死体など危険な描写
- 性的・過激・暴力的な画像、または危険なシンボルを含む画像

【安全とみなす条件】
- 日常的・一般的・ビジネス的・教育的な写真
  （例：人がジャンプ・走る・笑う・話す・働く・旅行する）
- 風景、建物、動物、食べ物など通常の画像
- 教育・引用・中立的な表現で、害意や攻撃性がない内容
- 軽い冗談、ゲーム内表現、ポジティブなコメントなど

【出力ルール】
- 必ず「悪質」または「安全」のどちらかのみを日本語で返す
- 説明文や理由は一切書かない
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

    // 出力が曖昧な場合は安全寄りに倒す
    if (!["悪質", "安全"].includes(response)) {
      console.warn("⚠️ 不明な判定を検出:", response);
      return "安全";
    }

    return response;
  } catch (err) {
    console.error("Gemini判定エラー:", err);
    return "安全"; // エラー時は安全寄りに扱う（誤BAN防止）
  }
}

// 💬 メッセージイベント処理
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const username = message.author.username;
  const content = message.content;

  // ホワイトリストユーザーはスキップ
  if (WHITELIST_USERS.includes(username)) return;

  const attachments = message.attachments;
  const hasImage =
    attachments.size > 0 &&
    attachments.first().contentType?.startsWith("image/");

  try {
    let result;

    // 🖼️ 画像＋テキストを判定
    if (hasImage) {
      const imageUrl = attachments.first().url;
      result = await judgeContent({ text: content, imageUrl });
      console.log(`[Gemini画像+テキスト判定] ${username}: ${result}`);
    } else {
      // ✉️ テキストのみ判定
      result = await judgeContent({ text: content });
      console.log(`[Geminiテキスト判定] ${username}: ${result}`);
    }

    // 🚫 悪質判定の場合タイムアウト
    if (result === "悪質") {
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
      option
        .setName("target")
        .setDescription("メッセージを送る相手")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("送る内容")
        .setRequired(true)
    ),
].map((command) => command.toJSON());

// コマンド登録
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

// Discordログイン
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
