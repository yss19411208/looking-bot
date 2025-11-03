// main.mjs - Discord Botのメインプログラム（レート制限対策版）

// 必要なライブラリを読み込み
import { Client, GatewayIntentBits, SlashCommandBuilder, Routes, REST } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import express from 'express';
import fetch from 'node-fetch';

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

// Botが起動完了したときの処理
client.once('ready', () => {
    console.log(`🎉 ${client.user.tag} が正常に起動しました！`);
    console.log(`📊 ${client.guilds.cache.size} つのサーバーに参加中`);
});

// メッセージが送信されたときの処理
client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    
    if (message.content.toLowerCase() === 'ping') {
        message.reply('🏓 pong!');
        console.log(`📝 ${message.author.tag} が ping コマンドを使用`);
    }
});

const genAI = new GoogleGenerativeAI(process.env.AI_TOKEN);

// 👤 ホワイトリスト（AI判定をスキップ）
const WHITELIST_USERS = ["harima1945"];

// ⏱ タイムアウト時間（ミリ秒）
const TIMEOUT_DURATION = 10 * 60 * 1000;

// ⏱ API タイムアウト時間（30秒）
const API_TIMEOUT = 30000;

// 🚦 レート制限管理
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 5000; // 各リクエスト間隔を5秒に延長（429エラー防止）
let requestQueue = Promise.resolve(); // リクエストを順番に処理するためのキュー

// 🔄 レート制限を考慮したAPI呼び出し（必ず結果が出るまでリトライ）
async function callAPI(apiFunc) {
    // リクエストをキューに追加して順番に処理
    return new Promise((resolve) => {
        requestQueue = requestQueue.then(async () => {
            let attempt = 0;
            while (true) {
                attempt++;
                try {
                    // レート制限: 前回のリクエストから十分な時間が経過するまで待機
                    const now = Date.now();
                    const timeSinceLastRequest = now - lastRequestTime;
                    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
                        const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
                        console.log(`[レート制限] ${waitTime}ms 待機中...`);
                        await new Promise(res => setTimeout(res, waitTime));
                    }
                    
                    lastRequestTime = Date.now();
                    const result = await apiFunc();
                    console.log(`✅ API呼び出し成功 (試行回数: ${attempt})`);
                    resolve(result);
                    return; // 成功したのでループを抜ける
                } catch (err) {
                    if (err.message.includes('429') || err.message.includes('Resource exhausted')) {
                        const waitTime = Math.min(5000 * attempt, 30000); // 5秒, 10秒, 15秒... 最大30秒
                        console.log(`⚠️ 429エラー発生 (試行回数: ${attempt}): ${waitTime/1000}秒待機してから再実行します...`);
                        await new Promise(res => setTimeout(res, waitTime));
                        // ループを続けて再実行
                    } else {
                        console.error(`[APIエラー]:`, err.message);
                        // 429以外のエラーの場合は5秒待ってリトライ
                        console.log(`⚠️ エラー発生: 5秒待機してから再実行します...`);
                        await new Promise(res => setTimeout(res, 5000));
                    }
                }
            }
        });
    });
}

// 🖼️ 画像をBase64に変換する関数
async function fetchImageAsBase64(url) {
    try {
        console.log(`[画像取得開始] ${url.substring(0, 50)}...`);
        const response = await fetch(url, { timeout: 10000 });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        console.log(`[画像取得完了] ${(buffer.byteLength/1024).toFixed(2)}KB`);
        
        return {
            inlineData: {
                data: base64,
                mimeType: contentType
            }
        };
    } catch (err) {
        console.error('[画像取得エラー]:', err.message);
        return null;
    }
}

// 🔍 テキストメッセージの判定
async function checkTextContent(content) {
    try {
        console.log(`[テキスト判定開始] 長さ: ${content.length}`);
        const MODEL_ID = "gemini-2.5-flash"; // 正しいモデル名
        const model = genAI.getGenerativeModel({ model: MODEL_ID });
        
        const prompt = `以下のメッセージが「攻撃的」「差別的」「脅迫的」「スパム」「不快」などの場合は「悪質」と判定してください。
日本語で、"悪質" または "安全" のどちらかで答えてください。

メッセージ: ${content}`;

        const result = await callAPI(async () => {
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('テキスト判定タイムアウト')), API_TIMEOUT)
            );
            return await Promise.race([
                model.generateContent(prompt),
                timeoutPromise
            ]);
        });
        
        const response = result.response.text().trim();
        console.log(`[テキスト判定完了] ${response}`);
        return response.includes("悪質");
    } catch (err) {
        console.error("[テキスト判定エラー]:", err.message);
        // エラーが発生しても callAPI が無限リトライするので、ここには到達しないはず
        return false;
    }
}

// 🖼️ 画像の判定
async function checkImageContent(imageData) {
    try {
        console.log(`[画像判定開始]`);
        const MODEL_ID = "gemini-2.5-flash"; // 正しいモデル名
        const model = genAI.getGenerativeModel({ model: MODEL_ID });
        
        const prompt = `この画像を詳しく分析してください。

【重要】画像内に文字やテキストが含まれている場合は、必ずその内容も確認してください。

以下のいずれかに該当する場合は「悪質」と判定してください:
- 暴力的な内容や暴力を助長する表現
- 性的に露骨な内容
- ヘイトスピーチや差別的な内容
- グロテスクな内容
- 攻撃的な言葉や脅迫的な言葉（「死ね」「殺す」など）が含まれている
- 誰かを傷つける意図がある内容
- その他不適切な内容

日本語で、"悪質" または "安全" のどちらか一言だけで答えてください。`;

        const result = await callAPI(async () => {
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('画像判定タイムアウト')), API_TIMEOUT)
            );
            return await Promise.race([
                model.generateContent([prompt, imageData]),
                timeoutPromise
            ]);
        });
        
        const response = result.response.text().trim();
        console.log(`[画像判定完了] ${response}`);
        return response.includes("悪質");
    } catch (err) {
        console.error("[画像判定エラー]:", err.message);
        // エラーが発生しても callAPI が無限リトライするので、ここには到達しないはず
        return false;
    }
}

client.on("messageCreate", async (message) => {
    if (message.author.bot || !message.guild) return;

    const username = message.author.username;
    const content = message.content;

    // ホワイトリストはスキップ
    if (WHITELIST_USERS.includes(username)) return;

    let isMalicious = false;
    let reason = "";

    try {
        // 📝 テキストコンテンツの判定
        if (content && content.trim().length > 0) {
            const textIsMalicious = await checkTextContent(content);
            if (textIsMalicious) {
                isMalicious = true;
                reason = "不適切なテキスト";
                console.log(`[判定結果] ${username}: テキストが悪質`);
            } else {
                console.log(`[判定結果] ${username}: テキストは安全`);
            }
        }

        // 🖼️ 画像の判定
        if (message.attachments.size > 0) {
            console.log(`[添付ファイル検出] ${message.attachments.size}個`);
            
            for (const attachment of message.attachments.values()) {
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    console.log(`[画像検出] ${username}: ${attachment.name}`);
                    
                    const imageData = await fetchImageAsBase64(attachment.url);
                    if (imageData) {
                        const imageIsMalicious = await checkImageContent(imageData);
                        if (imageIsMalicious) {
                            isMalicious = true;
                            reason = reason ? reason + "、不適切な画像" : "不適切な画像";
                            console.log(`[判定結果] ${username}: 画像が悪質`);
                        } else {
                            console.log(`[判定結果] ${username}: 画像は安全`);
                        }
                    }
                }
            }
        }

        // 🚨 悪質と判定された場合の処理
        if (isMalicious) {
            const member = await message.guild.members.fetch(message.author.id);
            await member.timeout(TIMEOUT_DURATION, `Geminiによる判定: ${reason}`);

            try {
                await message.delete();
                console.log(`🗑️ ${username} のメッセージを削除`);
            } catch (delErr) {
                console.error("削除エラー:", delErr.message);
            }

            await message.channel.send(
                `⚠️ **${username}** をタイムアウトしました\n理由: ${reason}が検出されました`
            );
            console.log(`⛔ ${username} をタイムアウト (理由: ${reason})`);
        } else {
            console.log(`✅ ${username}: チェックをパス`);
        }
    } catch (err) {
        console.error("[メイン処理エラー]:", err.message);
        
        // レート制限エラーの場合は警告を送信
        if (err.message.includes('レート制限')) {
            await message.channel.send(
                `⚠️ AI判定がレート制限に達しました。しばらくお待ちください。`
            ).catch(() => {});
        }
    }
});

const TOKEN = process.env.DISCORD_TOKEN;
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

const rest = new REST({ version: "10" }).setToken(TOKEN);
await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

client.on("interactionCreate", async interaction => {
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

// 💬 Discordログ送信チャンネル設定
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // .env に追加しておく

// console.log を上書きして Discord に送信
const originalLog = console.log;
console.log = async (...args) => {
    const text = args.map(a => (typeof a === "object" ? JSON.stringify(a, null, 2) : a)).join(" ");
    originalLog.apply(console, args); // 元のコンソール出力も保持
    
    try {
        if (client && client.isReady() && LOG_CHANNEL_ID) {
            const channel = await client.channels.fetch(LOG_CHANNEL_ID);
            if (channel && channel.isTextBased()) {
                // Discordのメッセージ上限は2000文字
                if (text.length > 1900) {
                    await channel.send("ログが長すぎるため一部省略:\n" + text.slice(0, 1900));
                } else {
                    await channel.send(text);
                }
            }
        }
    } catch (err) {
        originalLog("⚠️ ログ送信エラー:", err.message);
    }
};

client.on('error', (error) => {
    console.error('❌ Discord クライアントエラー:', error);
});

process.on('SIGINT', () => {
    console.log('🛑 Botを終了しています...');
    client.destroy();
    process.exit(0);
});

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

// Express Webサーバーの設定
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({
        status: 'Bot is running! 🤖',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.listen(port, () => {
    console.log(`🌐 Web サーバーがポート ${port} で起動しました`);
});