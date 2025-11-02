// main.mjs - Discord Botのメインプログラム

// 必要なライブラリを読み込み
import { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import express from 'express';

// .envファイルから環境変数を読み込み
dotenv.config();

// Discord Botクライアントを作成
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,           // サーバー情報取得
        GatewayIntentBits.GuildMessages,    // メッセージ取得
        GatewayIntentBits.MessageContent,   // メッセージ内容取得
        GatewayIntentBits.GuildMembers,     // メンバー情報取得
    ],
});

// Botが起動完了したときの処理
client.once('ready', () => {
    console.log(`🎉 ${client.user.tag} が正常に起動しました！`);
    console.log(`📊 ${client.guilds.cache.size} つのサーバーに参加中`);
});

// メッセージが送信されたときの処理
client.on('messageCreate', (message) => {
    // Bot自身のメッセージは無視
    if (message.author.bot) return;
    
    // 「ping」メッセージに反応
    if (message.content.toLowerCase() === 'ping') {
        message.reply('🏓 pong!');
        console.log(`📝 ${message.author.tag} が ping コマンドを使用`);
    }
});

const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);

// 👤 ホワイトリスト（AI判定をスキップ）
const WHITELIST_USERS = ["harima1945"];

// ⏱ タイムアウト時間（ミリ秒）
// 例: 10分 → 10 * 60 * 1000
const TIMEOUT_DURATION = 10 * 60 * 1000;

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const username = message.author.username;
  const content = message.content;

  // ホワイトリストはスキップ
  if (WHITELIST_USERS.includes(username)) return;

  try {
    // Geminiに「悪質かどうか」を問い合わせる
    const MODEL_ID = "gemini-2.5-flash";  // ドキュメント上で使えるモデル名の一例
    const model = genAI.getGenerativeModel({ model: MODEL_ID });
    const prompt = `
以下のメッセージが「攻撃的」「差別的」「脅迫的」「スパム」「不快」などの場合は「悪質」と判定してください。
日本語で、"悪質" または "安全" のどちらかで答えてください。

メッセージ: ${content}
    `;

    const result = await model.generateContent(prompt);
    const response = result.response.text().trim();

    console.log(`[Gemini判定] ${username}: ${response}`);

    // Geminiが「悪質」と判定した場合のみ処理
    if (response.includes("悪質")) {
      const member = await message.guild.members.fetch(message.author.id);

      // タイムアウト実行
      await member.timeout(TIMEOUT_DURATION, "Geminiによる不適切メッセージ判定");

      // メッセージの下に通知を送信
      await message.reply(
        `⚠️ **${username}** をタイムアウトしました（理由: 不適切な発言が検出されました）`
      );

      console.log(`⛔ ${username} をタイムアウトしました`);
    }
  } catch (err) {
    console.error("Gemini判定またはタイムアウト時のエラー:", err);
  }
});

const TOKEN = process.env.DISCORD_TOKEN
const CLIENT_ID = process.env.CLIENT_ID;

const commands = [
  new SlashCommandBuilder()
    .setName("send")
    .setDescription("指定したユーザーに秘密のメッセージを送る")
    .addUserOption(option =>
      option.setName("target").setDescription("メッセージを送る相手").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("message").setDescription("送る内容").setRequired(true)
    ),
].map(command => command.toJSON());

// コマンド登録
const rest = new REST({ version: "10" }).setToken(TOKEN);
await rest.put(
  Routes.applicationCommands(CLIENT_ID), // GUILD_IDを削除
  { body: commands }
);;

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "send") {
    const target = interaction.options.getUser("target");
    const message = interaction.options.getString("message");

    try {
      // DM送信
      await target.send(`📩 **${interaction.user.tag}** からのメッセージ:\n${message}`);
      await interaction.reply({
        content: `✅ ${target.tag} にメッセージを送信しました（DMで）`,
        ephemeral: true, // 実行者にしか見えない
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

// エラーハンドリング
client.on('error', (error) => {
    console.error('❌ Discord クライアントエラー:', error);
});

// プロセス終了時の処理
process.on('SIGINT', () => {
    console.log('🛑 Botを終了しています...');
    client.destroy();
    process.exit(0);
});

// Discord にログイン
if (!process.env.DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN が .env ファイルに設定されていません！');
    process.exit(1);
}

console.log('🔄 Discord に接続中...');
client.login(process.env.DISCORD_TOKEN)
    .catch(error => {
        console.error('❌ ログインに失敗しました:', error);
        process.exit(1);
    });

// Express Webサーバーの設定（Render用）
const app = express();
const port = process.env.PORT || 3000;

// ヘルスチェック用エンドポイント
app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running! 🤖',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// サーバー起動
app.listen(port, () => {
    console.log(`🌐 Web サーバーがポート ${port} で起動しました`);
    console.log("AI_TOKEN =", process.env.AI_TOKEN);
    console.log("DISCORD_TOKEN =", process.env.DISCORD_TOKEN);
    console.log("CLIENT_ID =", process.env.CLIENT_ID);
});