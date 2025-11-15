// main.mjs（自然なレインボー対応版）

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

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`🎉 ${client.user.tag} が起動しました！`);
});
// =============================
// 🧠 以下は元のGemini監視部分
// =============================

const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);
const WHITELIST_USERS = ["harima1945"];
const TIMEOUT_DURATION = 30 * 60 * 1000;
const API_TIMEOUT = 30000;
const MIN_REQUEST_INTERVAL = 5000;
let lastRequestTime = 0;
let requestQueue = Promise.resolve();
const LOG_CHANNEL_ID = process.env.CHANNEL_ID;

async function sendLog(content) {
  console.log(content);
  const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (channel) channel.send(`**LOG:** ${content}`).catch(() => {});
}

async function callAPI(apiFunc) {
  return new Promise((resolve) => {
    requestQueue = requestQueue.then(async () => {
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          const now = Date.now();
          const timeSinceLastRequest = now - lastRequestTime;
          if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
            const wait = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            await new Promise((res) => setTimeout(res, wait));
          }

          lastRequestTime = Date.now();
          const result = await apiFunc();
          resolve(result);
          return;
        } catch (err) {
          if (err.message.includes("429") || err.message.includes("Resource exhausted")) {
            const wait = Math.min(5000 * attempt, 30000);
            await new Promise((res) => setTimeout(res, wait));
          } else {
            await new Promise((res) => setTimeout(res, 5000));
          }
        }
      }
    });
  });
}

async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url, { timeout: 10000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("image/gif")) {
      console.log(`🚫 GIF画像はスキップ: ${url}`);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { inlineData: { data: base64, mimeType: contentType || "image/jpeg" } };
  } catch (err) {
    console.error("[画像取得エラー]:", err.message);
    return null;
  }
}

async function checkTextContent(content) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
以下のメッセージが攻撃的・差別的・脅迫的・スパム・不快などの場合「悪質」と判定してください。
"悪質" または "安全" のどちらかだけを返答してください。

メッセージ: ${content}`;
    const result = await callAPI(async () => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("テキスト判定タイムアウト")), API_TIMEOUT)
      );
      return await Promise.race([model.generateContent(prompt), timeout]);
    });
    const response = result.response.text().trim();
    return response.includes("悪質");
  } catch {
    return false;
  }
}

async function checkImageContent(imageData) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `
この画像を分析してください。
不適切な内容（暴力・性的・差別・グロ・脅迫・不快など）があれば「悪質」と判定。
"悪質" または "安全" のどちらかだけを返答してください。`;

    const result = await callAPI(async () => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("画像判定タイムアウト")), API_TIMEOUT)
      );
      return await Promise.race([model.generateContent([prompt, imageData]), timeout]);
    });
    const response = result.response.text().trim();
    return response.includes("悪質");
  } catch {
    return false;
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const username = message.author.username;
  const content = message.content;
  if (WHITELIST_USERS.includes(username)) return;

  let isMalicious = false;
  let reason = "";

  if (content && content.trim()) {
    if (await checkTextContent(content)) {
      isMalicious = true;
      reason = "不適切なテキスト";
    }
  }

  if (message.attachments.size > 0) {
    for (const attachment of message.attachments.values()) {
      if (attachment.contentType?.startsWith("image/")) {
        const imageData = await fetchImageAsBase64(attachment.url);
        if (imageData && (await checkImageContent(imageData))) {
          isMalicious = true;
          reason = reason ? reason + "、不適切な画像" : "不適切な画像";
        }
      }
    }
  }

  if (isMalicious) {
    const member = await message.guild.members.fetch(message.author.id);
    await member.timeout(TIMEOUT_DURATION, `Geminiによる判定: ${reason}`);
    await message.channel.send(`⚠️ **${username}** をタイムアウトしました\n理由: ${reason}`);
    await sendLog(`⛔ ${username} タイムアウト: ${reason}`);
  }
});

console.log("🔄 Discordに接続中...");
client.login(process.env.DISCORD_TOKEN);

const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) =>
  res.json({ status: "Bot is running! 🤖", uptime: process.uptime(), timestamp: new Date().toISOString() })
);
app.listen(port, () => console.log(`🌐 Webサーバー起動: ポート ${port}`));
