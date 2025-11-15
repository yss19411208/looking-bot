// main.mjs（完全版）

import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
} from "discord.js";
import { GoogleGenerativeAI } from "@google-generative-ai";
import dotenv from "dotenv";
import express from "express";
import fetch from "node-fetch";

dotenv.config();

// ==============================
// 🔧 Discord クライアント
// ==============================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ==============================
// 📌 ログ送信用
// ==============================
const LOG_CHANNEL_ID = process.env.CHANNEL_ID;
async function sendLog(msg) {
  console.log(msg);
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    ch?.send(`📘 **LOG:**\n${msg}`);
  } catch {}
}

// console.log を完全に上書きして Discord に送信
const originalLog = console.log;
console.log = function (...args) {
  originalLog(...args);
  sendLog(args.join(" "));
};

// ==============================
// 🧠 Gemini（AI強化版）
// ==============================
const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);

async function aiJudgeText(content) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
次のテキストを「1〜5」で不適切度を採点してください。
1 = 全く問題なし
5 = 暴力、性的、差別、犯罪、脅迫など非常に危険

返答は数字のみ。

テキスト:
${content}
`;

  try {
    const res = await model.generateContent(prompt);
    const text = res.response.text().trim();
    const score = parseInt(text, 10);

    return isNaN(score) ? 1 : score;
  } catch {
    return 1;
  }
}

async function aiJudgeImage(imageData) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
この画像の不適切度を「1〜5」で採点してください。
1 = 問題なし
5 = 暴力、性的、差別、犯罪、脅迫など非常に危険

返答は数字のみ。
`;

  try {
    const res = await model.generateContent([prompt, imageData]);
    const text = res.response.text().trim();
    const score = parseInt(text, 10);

    return isNaN(score) ? 1 : score;
  } catch {
    return 1;
  }
}

// ==============================
// 📘 画像を BASE64 へ
// ==============================
async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const type = res.headers.get("content-type");

    if (type.includes("gif")) {
      console.log(`GIF はスキップ: ${url}`);
      return null;
    }

    const buffer = await res.arrayBuffer();
    return {
      inlineData: {
        data: Buffer.from(buffer).toString("base64"),
        mimeType: type,
      },
    };
  } catch {
    return null;
  }
}

// ==============================
// ⚡ メッセージ監視
// ==============================
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  let maxScore = 1;

  // ---- テキスト ----
  if (message.content.trim()) {
    const score = await aiJudgeText(message.content);
    maxScore = Math.max(maxScore, score);
    console.log(`テキストスコア: ${score}`);
  }

  // ---- 画像 ----
  for (const att of message.attachments.values()) {
    if (att.contentType?.startsWith("image/")) {
      const img = await fetchImageAsBase64(att.url);
      if (img) {
        const score = await aiJudgeImage(img);
        maxScore = Math.max(maxScore, score);
        console.log(`画像スコア: ${score}`);
      }
    }
  }

  // ---- Timeout判定 ----
  if (maxScore >= 4) {
    const member = await message.guild.members.fetch(message.author.id);
    await member.timeout(30 * 60 * 1000, `AI判定: スコア${maxScore}`);

    message.channel.send(
      `⚠️ **${message.author.username}** をタイムアウトしました（AIスコア: ${maxScore}）`
    );
    sendLog(`⛔ Timeout: ${message.author.username}（スコア:${maxScore}）`);
  }
});

// ==============================
// 🧩 Slash Commands（/to /TOP）
// ==============================
const commands = [
  new SlashCommandBuilder()
    .setName("to")
    .setDescription("動作確認用コマンド"),

  new SlashCommandBuilder()
    .setName("top")
    .setDescription("AIを通さずにTimeoutをテストする（管理者限定）")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("対象ユーザー").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function register() {
  try {
    console.log("スラッシュコマンド登録中...");
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log("スラッシュコマンド登録完了！");
  } catch (e) {
    console.log("コマンド登録エラー:", e);
  }
}
register();

// ==============================
// ⚡ Slash コマンド処理
// ==============================
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === "to") {
    await i.reply("👍 `/to` が実行されました！");
  }

  if (i.commandName === "top") {
    const user = i.options.getUser("user");
    const member = await i.guild.members.fetch(user.id);

    await member.timeout(30 * 60 * 1000, "/TOP（管理者）による強制実行");

    await i.reply(`🔨 管理者により **${user.username}** が Timeout されました`);
    sendLog(`🔨 /TOP → ${user.username} Timeout`);
  }
});

// ==============================
// 🔌 起動
// ==============================
client.once("ready", () => {
  console.log(`🎉 Bot 起動: ${client.user.tag}`);
});

console.log("Discord に接続中…");
client.login(process.env.DISCORD_TOKEN);

// ==============================
// 🌐 Web Server
// ==============================
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(process.env.PORT || 3000);
