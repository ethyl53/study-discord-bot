const cron = require('node-cron');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const db = require('../database/db');
const { formatTime, generateTimelineBuffer, resolveSubject } = require('../utils/timeline');

// 💡 前日の02:00(JST) 〜 今日の01:59:59.999(JST) を計算
function getDailyRange() {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const currentHour = jstNow.getUTCHours();

    const baseDate = new Date(jstNow);
    if (currentHour < 2) {
        baseDate.setUTCDate(baseDate.getUTCDate() - 1);
    }

    const start = new Date(baseDate);
    start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCHours(2, 0, 0, 0);

    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    end.setTime(end.getTime() - 1); 

    return { 
        startMs: start.getTime() - 9 * 60 * 60 * 1000, 
        endMs: end.getTime() - 9 * 60 * 60 * 1000 
    };
}

function getWeeklyRange() {
    const daily = getDailyRange();
    const startMs = daily.startMs - 6 * 24 * 60 * 60 * 1000;
    return { startMs, endMs: daily.endMs };
}

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

async function buildRankingAndTimeline(client, startMs, endMs, title, color, includeTimeline = false) {
    const nowMs = Date.now();

    const result = await db.query(`
        SELECT id, user_id, start_time, end_time, total_time, total_paused_time, pause_start_time, status, subject, task_name
        FROM study_intervals
        WHERE start_time <= $2::bigint AND (end_time IS NULL OR end_time >= $1::bigint)
        ORDER BY start_time ASC
    `, [startMs, endMs]);

    const rows = result.rows;
    const userStats = {};

    for (const row of rows) {
        const duration = calculateActiveTimeInRange(row, startMs, endMs, nowMs);
        if (duration <= 0) continue;

        const userId = row.user_id;
        const subjectInfo = resolveSubject(row.subject || row.task_name);

        if (!userStats[userId]) {
            userStats[userId] = { userId, totalTime: 0, sessions: [] };
        }

        userStats[userId].totalTime += duration;
        
        if (includeTimeline) {
            const startTime = Number(row.start_time);
            const endTime = row.end_time ? Number(row.end_time) : nowMs;

            userStats[userId].sessions.push({
                start: Math.max(startTime, startMs),
                end: Math.min(endTime, endMs),
                colorHex: subjectInfo.hex,
                pauses: [] 
            });
        }
    }

    const sortedUsers = Object.values(userStats).sort((a, b) => b.totalTime - a.totalTime);
    
    const missingUserIds = sortedUsers
        .map(u => u.userId)
        .filter(id => !client.users.cache.has(id));

    if (missingUserIds.length > 0) {
        await Promise.allSettled(missingUserIds.map(id => client.users.fetch(id)));
    }

    let text = '';
    const medals = ['🥇', '🥈', '🥉'];
    const timelineData = [];

    for (let i = 0; i < sortedUsers.length; i++) {
        const stat = sortedUsers[i];
        
        const cachedUser = client.users.cache.get(stat.userId);
        const username = cachedUser 
            ? (cachedUser.displayName || cachedUser.username)
            : `ユーザー(${stat.userId.slice(-4)})`;

        if (includeTimeline) {
            timelineData.push({ username, sessions: stat.sessions });
        }
        
        const rankIcon = medals[i] || `**${i+1}.**`;
        text += `${rankIcon} ${username}\n**${formatTime(stat.totalTime)}**\n\n`;
    }

    if (!text) text = '作業記録がありませんでした。';

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(text)
        .setColor(color)
        .setTimestamp();

    let attachment = null;
    if (includeTimeline && timelineData.length > 0) {
        const buffer = await generateTimelineBuffer(timelineData, startMs);
        const fileName = `daily_summary_${Date.now()}.png`;
        attachment = new AttachmentBuilder(buffer, { name: fileName });
        embed.setImage(`attachment://${fileName}`);
    }

    return { embed, attachment };
}

module.exports = (client, persistentRankingManager) => {
    cron.schedule('0 2 * * *', async () => {
        const channelId = process.env.RANKING_CHANNEL_ID;
        if (!channelId) return;

        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel) return;

            const dailyRange = getDailyRange();
            const { embed: dailyEmbed, attachment: dailyAttachment } = await buildRankingAndTimeline(
                client, dailyRange.startMs, dailyRange.endMs, '📊 昨日の作業ランキング', 0x00BFFF, true
            );
            
            const dailyPayload = { embeds: [dailyEmbed] };
            if (dailyAttachment) dailyPayload.files = [dailyAttachment];
            await channel.send(dailyPayload);

            // 💡 JST基準で月曜日(1)を判定
            const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
            if (jstNow.getUTCDay() === 1) { 
                const weeklyRange = getWeeklyRange();
                const { embed: weeklyEmbed } = await buildRankingAndTimeline(
                    client, weeklyRange.startMs, weeklyRange.endMs, '📅 週間作業ランキング', 0x00FF7F, false
                );
                await channel.send({ embeds: [weeklyEmbed] });
            }

            if (persistentRankingManager?.resend) {
                await persistentRankingManager.resend();
            }

        } catch (e) {
            console.error('[Time Signal Cron Error]', e);
        }
    }, {
        timezone: "Asia/Tokyo"
    });
};