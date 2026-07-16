const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database/db');

const WARN_TIMEOUT = 3 * 60 * 60 * 1000;
const AUTO_STOP_TIMEOUT = 15 * 60 * 1000;

async function initMonitor(client) {
    setInterval(async () => {
        const now = Date.now();

        try {
            // スケジュール通知処理
            const schedules = await db.query(
                `SELECT id, user_id, title, description, event_time FROM user_schedules WHERE remind_time <= $1`,
                [now]
            );

            for (const row of schedules.rows) {
                try {
                    const user = await client.users.fetch(row.user_id);
                    const eventDate = new Date(Number(row.event_time)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                    await user.send(`[スケジュール通知]\n指定時刻に到達しました。\n\n件名: ${row.title}\n内容: ${row.description || 'なし'}\n日時(JST): ${eventDate}`);
                } catch (err) {
                    // 通知エラー無視
                }
                await db.query(`DELETE FROM user_schedules WHERE id = $1`, [row.id]);
            }

            // 放置警告処理
            const warningTargets = await db.query(`
                SELECT id, user_id, task_name, start_time
                FROM study_intervals
                WHERE status = 'active'
                AND ($1 - COALESCE(last_checked_at, start_time)) > $2
            `, [now, WARN_TIMEOUT]);

            for (const row of warningTargets.rows) {
                try {
                    const user = await client.users.fetch(row.user_id);
                    const rowButton = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`keep_working_${row.user_id}`)
                            .setLabel('継続')
                            .setStyle(ButtonStyle.Primary)
                    );

                    await user.send({
                        content: `[システム警告]\n作業「${row.task_name || '未設定'}」の開始から規定時間を超過しました。継続状態の確認を要求します。応答がない場合、記録は自動停止されます。`,
                        components: [rowButton]
                    });
                } catch (err) {
                    // 通知エラー無視
                }

                await db.query(`UPDATE study_intervals SET last_checked_at = $1 WHERE id = $2`, [now, row.id]);
            }

            // 自動停止処理
            const stopTargets = await db.query(`
                SELECT id, user_id, task_name, start_time, total_paused_time, last_checked_at
                FROM study_intervals
                WHERE status = 'active' AND last_checked_at IS NOT NULL
                AND ($1 - last_checked_at) > $2
            `, [now, AUTO_STOP_TIMEOUT]);

            for (const row of stopTargets.rows) {
                const stopTime = Number(row.last_checked_at);
                const startTime = Number(row.start_time);
                const pausedDuration = Number(row.total_paused_time || 0);
                
                const totalTime = Math.max(0, stopTime - startTime - pausedDuration);

                await db.query(`
                    UPDATE study_intervals
                    SET end_time = $1, total_time = $2, status = 'completed', last_checked_at = NULL
                    WHERE id = $3
                `, [stopTime, totalTime, row.id]);

                try {
                    const user = await client.users.fetch(row.user_id);
                    await user.send(`[システム通知]\n応答が確認できなかったため、作業「${row.task_name || '未設定'}」を停止処理しました。`);
                } catch (err) {
                    // 通知エラー無視
                }
            }
        } catch (err) {
            console.error('[Monitor Error]', err);
        }
    }, 300000);
}

module.exports = { initMonitor };