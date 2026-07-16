const cron = require('node-cron');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const db = require('../database/db');
const { formatTime, generateTimelineBuffer, resolveSubject } = require('../utils/timeline');

// 💡 サーバーのタイムゾーンに依存せず、正確に「日本時間の今日AM2:00」のエポックミリ秒を取得する関数
function getTodayStartJST() {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000); // 強制的にJSTへシフト
    const currentHour = jstNow.getUTCHours();

    if (currentHour < 2) {
        jstNow.setUTCDate(jstNow.getUTCDate() - 1);
    }
    jstNow.setUTCHours(2, 0, 0, 0);
    
    return jstNow.getTime() - 9 * 60 * 60 * 1000; // 実際のUTCエポックに戻す
}

// 💡 同様に「日本時間の今週月曜AM2:00」を取得
function getWeeklyStartJST() {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const currentHour = jstNow.getUTCHours();
    const day = jstNow.getUTCDay(); // 0:日, 1:月, 2:火...
    
    const diff = (day === 0 ? -6 : 1) - day;
    jstNow.setUTCDate(jstNow.getUTCDate() + diff);

    if (day === 1 && currentHour < 2) {
        jstNow.setUTCDate(jstNow.getUTCDate() - 7);
    }

    jstNow.setUTCHours(2, 0, 0, 0);
    return jstNow.getTime() - 9 * 60 * 60 * 1000;
}

// 指定期間（startMs 〜 endMs）における実作業時間を比例按分して算出
function calculateActiveTimeInRange(row, startMs, endMs, nowMs) {
    const startTime = Number(row.start_time);
    const endTime = row.end_time ? Number(row.end_time) : nowMs;

    const actualStart = Math.max(startTime, startMs);
    const actualEnd = Math.min(endTime, endMs);

    if (actualStart >= actualEnd) return 0;

    const totalSessionTime = endTime - startTime;
    if (totalSessionTime <= 0) return 0;

    let totalPaused = Number(row.total_paused_time || 0);
    if (row.status === 'paused' && row.pause_start_time) {
        const pauseStart = Number(row.pause_start_time);
        if (nowMs > pauseStart) {
            totalPaused += (nowMs - pauseStart);
        }
    }

    const totalActiveTime = Math.max(0, totalSessionTime - totalPaused);
    const overlapTime = actualEnd - actualStart;
    const ratio = overlapTime / totalSessionTime;

    return Math.max(0, totalActiveTime * ratio);
}

// 現在作業中・一時停止中のユーザー一覧を取得
async function buildWorkingFields(client) {
    const nowMs = Date.now();
    const result = await db.query(`
        SELECT user_id, task_name, start_time, pause_start_time, total_paused_time, status, subject
        FROM study_intervals
        WHERE status IN ('active', 'paused')
        ORDER BY start_time ASC
    `);

    if (result.rows.length === 0) {
        return '現在、作業中のメンバーはいません。💤\n`/start` で作業を始めましょう！';
    }

    let text = '';
    for (const row of result.rows) {
        let username = `ユーザー(${row.user_id.slice(-4)})`;
        const user = client.users.cache.get(row.user_id);
        if (user) {
            username = user.displayName || user.username;
        }

        const startMs = Number(row.start_time);
        const totalPaused = Number(row.total_paused_time || 0);
        const taskName = row.task_name || '未設定';

        if (row.status === 'paused') {
            const pauseStartMs = Number(row.pause_start_time);
            const elapsedMs = pauseStartMs - startMs - totalPaused;
            text += `⏸️ **${username}** : 📝 \`${taskName}\` (${formatTime(elapsedMs)} で一時停止中)\n`;
        } else {
            const elapsedMs = nowMs - startMs - totalPaused;
            text += `🟢 **${username}** : 📝 \`${taskName}\` (${formatTime(elapsedMs)} 経過)\n`;
        }
    }
    return text;
}

// 今週のランキングEmbed構築
async function buildWeeklyEmbed(client) {
    const weeklyStart = getWeeklyStartJST();
    const nowMs = Date.now();

    const result = await db.query(`
        SELECT user_id, start_time, end_time, total_time, total_paused_time, pause_start_time, status
        FROM study_intervals
        WHERE start_time <= $2::bigint AND (end_time IS NULL OR end_time >= $1::bigint)
    `, [weeklyStart, nowMs]);

    const userStats = {};
    for (const row of result.rows) {
        const activeDuration = calculateActiveTimeInRange(row, weeklyStart, nowMs, nowMs);
        if (activeDuration <= 0) continue;

        const userId = row.user_id;
        userStats[userId] = (userStats[userId] || 0) + activeDuration;
    }

    const sortedUsers = Object.entries(userStats).sort((a, b) => b[1] - a[1]);

    let text = '';
    const medals = ['🥇', '🥈', '🥉'];
    for (let i = 0; i < sortedUsers.length; i++) {
        const [userId, timeMs] = sortedUsers[i];
        let username = `ユーザー(${userId.slice(-4)})`;
        const user = client.users.cache.get(userId);
        if (user) {
            username = user.displayName || user.username;
        }

        const rankIcon = medals[i] || `**${i+1}.**`;
        text += `${rankIcon} ${username} \u00A0\u00A0 **${formatTime(timeMs)}**\n`;
    }

    if (!text) text = 'まだ今週の作業記録がありません。';

    return new EmbedBuilder()
        .setTitle('📅 今週のランキング (月曜2:00～現在)')
        .setDescription(text)
        .setColor(0x00FF7F);
}

// 今日のランキング＆タイムライン画像構築
async function buildDailyData(client) {
    const dailyStart = getTodayStartJST();
    const nowMs = Date.now();

    const result = await db.query(`
        SELECT id, user_id, start_time, end_time, total_time, total_paused_time, pause_start_time, status, subject, task_name
        FROM study_intervals
        WHERE start_time <= $2::bigint AND (end_time IS NULL OR end_time >= $1::bigint)
        ORDER BY start_time ASC
    `, [dailyStart, nowMs]);

    const userStats = {};

    for (const row of result.rows) {
        const activeDuration = calculateActiveTimeInRange(row, dailyStart, nowMs, nowMs);
        if (activeDuration <= 0) continue;

        const userId = row.user_id;
        const subjectInfo = resolveSubject(row.subject || row.task_name);

        if (!userStats[userId]) {
            userStats[userId] = { userId, totalTime: 0, sessions: [] };
        }

        userStats[userId].totalTime += activeDuration;
        
        const startTime = Number(row.start_time);
        const endTime = row.end_time ? Number(row.end_time) : nowMs;

        userStats[userId].sessions.push({
            start: Math.max(startTime, dailyStart),
            end: Math.min(endTime, nowMs),
            colorHex: subjectInfo.hex,
            pauses: [] 
        });
    }

    const sortedUsers = Object.values(userStats).sort((a, b) => b.totalTime - a.totalTime);
    
    const timelineData = [];
    let text = '';
    const medals = ['🥇', '🥈', '🥉'];

    for (let i = 0; i < sortedUsers.length; i++) {
        const stat = sortedUsers[i];
        let username = `ユーザー(${stat.userId.slice(-4)})`;
        const user = client.users.cache.get(stat.userId);
        if (user) {
            username = user.displayName || user.username;
        }

        timelineData.push({ username, sessions: stat.sessions });
        
        const rankIcon = medals[i] || `**${i+1}.**`;
        text += `${rankIcon} ${username} \u00A0\u00A0 **${formatTime(stat.totalTime)}**\n`;
    }

    if (!text) text = '今日の作業記録はまだありません。';

    const embed = new EmbedBuilder()
        .setTitle('📊 今日のランキング＆タイムライン')
        .setDescription(text)
        .setColor(0x00BFFF)
        .setFooter({ text: '※作業開始/終了時にリアルタイム更新されます' })
        .setTimestamp();

    let attachment = null;
    if (timelineData.length > 0) {
        const buffer = await generateTimelineBuffer(timelineData, dailyStart);
        const fileName = `timeline_${Date.now()}.png`;
        
        attachment = new AttachmentBuilder(buffer, { name: fileName });
        embed.setImage(`attachment://${fileName}`);
    }

    return { embed, attachment };
}

// 送信・更新ロジック
async function updatePersistentRankingCore(client, forceResend = false) {
    const channelId = process.env.RANKING_CHANNEL_ID;
    if (!channelId) return;

    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        const workingText = await buildWorkingFields(client);
        const workingEmbed = new EmbedBuilder()
            .setTitle('🔥 現在リアルタイムで作業中のメンバー')
            .setDescription(workingText)
            .setColor(0xFFA500);

        const weeklyEmbed = await buildWeeklyEmbed(client);
        const dailyData = await buildDailyData(client);

        const messagePayload = {
            embeds: [workingEmbed, weeklyEmbed, dailyData.embed],
            files: dailyData.attachment ? [dailyData.attachment] : [],
            attachments: [] 
        };

        const stateRes = await db.query(`SELECT value FROM bot_state WHERE key = 'ranking_message_id'`);
        let messageId = stateRes.rows.length ? stateRes.rows[0].value : null;

        let targetMessage = null;
        if (messageId) {
            try {
                targetMessage = await channel.messages.fetch(messageId);
            } catch (e) {
                targetMessage = null; 
            }
        }

        if (forceResend && targetMessage) {
            await targetMessage.delete().catch(() => null);
            targetMessage = null;
        }

        if (targetMessage) {
            try {
                await targetMessage.edit(messagePayload);
            } catch (editError) {
                await targetMessage.delete().catch(() => null);
                const newMessage = await channel.send(messagePayload);
                await db.query(`
                    INSERT INTO bot_state (key, value) VALUES ('ranking_message_id', $1)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                `, [newMessage.id]);
            }
        } else {
            const newMessage = await channel.send(messagePayload);
            await db.query(`
                INSERT INTO bot_state (key, value) VALUES ('ranking_message_id', $1)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            `, [newMessage.id]);
        }
    } catch (e) {
        console.error('[Persistent Ranking Error]', e);
    }
}

function checkMemory() {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 450) {
        console.error('[MEM] limit exceeded. exiting.');
        process.exit(1); 
    }
}

let isUpdating = false;
let updatePending = false;
let resendPending = false;

async function safeUpdate(client, forceResend = false) {
    if (forceResend) resendPending = true;
    if (isUpdating) {
        updatePending = true;
        return;
    }
    isUpdating = true;

    while (true) {
        const shouldResend = resendPending;
        resendPending = false;
        updatePending = false;

        try {
            await updatePersistentRankingCore(client, shouldResend);
            checkMemory();
        } catch (err) {
            console.error('[Safe Update Error]', err);
        }

        if (!updatePending && !resendPending) break; 
    }
    isUpdating = false;
}

let lastCronExecutionTime = 0;

module.exports = (client) => {
    // 10分ごとの定期判定
    cron.schedule('*/10 * * * *', async () => {
        try {
            // 💡 JST基準で平日9時〜16時を判定
            const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
            const dayOfWeek = jstNow.getUTCDay(); // 0:日, 1:月...
            const hour = jstNow.getUTCHours();    

            if (dayOfWeek >= 1 && dayOfWeek <= 5 && hour >= 9 && hour < 16) {
                return; 
            }

            const activeSessions = await db.query(`
                SELECT COUNT(*) FROM study_intervals 
                WHERE status IN ('active', 'paused')
            `);
            const activeCount = parseInt(activeSessions.rows[0].count, 10);
            const now = Date.now();

            if (activeCount === 0) {
                const IDLE_INTERVAL = 60 * 60 * 1000; 
                if (now - lastCronExecutionTime < IDLE_INTERVAL) return;
            }

            lastCronExecutionTime = now;
            safeUpdate(client, false);

        } catch (e) {
            console.error('[Cron Filter Error]', e);
            safeUpdate(client, false);
        }
    });

    return {
        resend: () => safeUpdate(client, true),
        update: () => safeUpdate(client, false)
    };
};