// main.mjs
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
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
  ],
});

// ====================================
// LOG用チャンネルへ console 出力を送信
// （無限ループを防ぐため、log→送信→log しない）
// ====================================
const originalLog = console.log;
console.log = (...args) => {
  originalLog(...args); // ローカルには出す

  const text = args.join(" ");
  const chId = process.env.CHANNEL_ID;
  if (!client.isReady() || !chId) return;

  const ch = client.channels.cache.get(chId);
  if (ch && ch.send) {
    ch.send("**LOG:** " + text).catch(() => {});
  }
};

// ====================================
// AIモデル
// ====================================
const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);

const WHITELIST_USERS = ["harima1945"];
const TIMEOUT_DURATION = 30 * 60 * 1000;
const API_TIMEOUT = 30000;

// レート制限対策
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000;
let requestQueue = Promise.resolve();

async function callAPI(apiFunc) {
  return new Promise((resolve) => {
    requestQueue = requestQueue.then(async () => {
      let attempt = 0;

      while (true) {
        attempt++;

        try {
          const now = Date.now();
          const diff = now - lastRequestTime;

          if (diff < MIN_REQUEST_INTERVAL) {
            await new Promise((r) =>
              setTimeout(r, MIN_REQUEST_INTERVAL - diff)
            );
          }

          lastRequestTime = Date.now();
          const r = await apiFunc();
          resolve(r);
          return;
        } catch (err) {
          if (err.message.includes("429")) {
            await new Promise((r) => setTimeout(r, 3000));
          } else {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    });
  });
}

// ====================================
// 画像取得
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
    return {
      inlineData: {
        data: buf.toString("base64"),
        mimeType: ct || "image/jpeg",
      },
    };
  } catch {
    return null;
  }
}

// ====================================
// AI テキスト判定
// ====================================
async function checkTextContent(text) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    const prompt = `
以下のメッセージが攻撃的・暴力的・差別的・脅迫的・不快な場合「悪質」。
それ以外は「安全」。

メッセージ:
${text}
`;

    const result = await callAPI(() =>
      model.generateContent(prompt)
    );

    const rep = result.response.text().trim();
    return rep.includes("悪質");
  } catch {
    return false;
  }
}

// ====================================
// AI 画像判定
// ====================================
async function checkImageContent(img) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    const prompt = `
画像に不適切（暴力・性的・差別など）があれば「悪質」。
それ以外は「安全」。
`;

    const result = await callAPI(() =>
      model.generateContent([prompt, img])
    );

    const rep = result.response.text().trim();
    return rep.includes("悪質");
  } catch {
    return false;
  }
}

// ====================================
// 監視：メッセージ
// ====================================
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (WHITELIST_USERS.includes(message.author.username)) return;

  let malicious = false;
  let reason = "";

  // テキスト
  if (message.content.trim().length > 0) {
    if (await checkTextContent(message.content)) {
      malicious = true;
      reason = "不適切なテキスト";
    }
  }

  // 画像
  for (const a of message.attachments.values()) {
    if (!a.contentType?.startsWith("image/")) continue;

    const img = await fetchImageAsBase64(a.url);
    if (img && (await checkImageContent(img))) {
      malicious = true;
      reason += reason ? "、不適切な画像" : "不適切な画像";
    }
  }

  if (malicious) {
    const member = await message.guild.members.fetch(message.author.id);
    await member.timeout(TIMEOUT_DURATION, reason);

    message.channel.send(
      `⛔ **${message.author.username}** を timeout しました\n理由: ${reason}`
    );

    console.log(`AUTO TIMEOUT → ${message.author.username}: ${reason}`);
  }
});

// ====================================
// Slash Commands
// ====================================
const commands = [
  new SlashCommandBuilder()
    .setName("top")
    .setDescription("指定ユーザーを timeout（管理者専用）")
    .addUserOption((o) =>
      o.setName("user").setDescription("対象ユーザー").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("seconds").setDescription("秒数").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("to")
    .setDescription("現在 timeout 中のユーザー一覧"),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

client.once("ready", async () => {
  console.log(`Bot login → ${client.user.tag}`);

  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: commands }
  );

  console.log("Slash Commands Registered");
});

// ====================================
// コマンド処理
// ====================================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ========== /top ==========
  if (interaction.commandName === "top") {
    const user = interaction.options.getUser("user");
    const sec = interaction.options.getInteger("seconds");

    const member = await interaction.guild.members.fetch(user.id);

    await member.timeout(sec * 1000, "管理者による手動timeout");

    interaction.reply(
      `⛔ 管理者が **${user.tag}** を ${sec} 秒 timeout しました`
    );

    console.log(`MANUAL TIMEOUT → ${user.tag}`);
  }

  // ========== /to：タイムアウト一覧 ==========
  if (interaction.commandName === "to") {
    await interaction.reply("⏳ 調査中…");

    const members = await interaction.guild.members.fetch();
    const timeoutUsers = members.filter(
      (m) => m.communicationDisabledUntilTimestamp
    );

    if (timeoutUsers.size === 0) {
      return interaction.editReply("✅ timeout 中のユーザーはいません");
    }

    let msg = "⛔ **timeout 中のユーザー一覧**\n\n";

    timeoutUsers.forEach((m) => {
      const end = m.communicationDisabledUntilTimestamp;
      const now = Date.now();
      const remain = Math.max(0, Math.floor((end - now) / 1000));

      msg += `👤 ${m.user.tag}\n`;
      msg += `・残り ${remain} 秒\n`;
      msg += `・理由: ${m.communicationDisabledUntilReason ?? "不明"}\n\n`;
    });

    interaction.editReply(msg);
  }
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
  res.json({
    status: "Bot is running!",
    uptime: process.uptime(),
    now: new Date().toISOString(),
  });
});

app.listen(port, () => console.log(`Web OK : ${port}`));
