const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const { resolveSubjectColor, resolveSubjectName } = require('../utils/timelineHelper');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('start')
        .setDescription('作業を開始、または一時停止から再開します')
        .addStringOption(option =>
            option.setName('subject')
                .setDescription('科目')
                .setRequired(true)
                .addChoices(
                    { name: '数学', value: 'math' },
                    { name: '化学', value: 'chemistry' },
                    { name: '物理', value: 'physics' },
                    { name: '英語', value: 'english' },
                    { name: '社会', value: 'social' },
                    { name: 'その他', value: 'other' }
                )
        )
        .addStringOption(option =>
            option.setName('task')
                .setDescription('具体的な作業内容 (例: 青チャート P.24)')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const userId = interaction.user.id;
        const subject = interaction.options.getString('subject');
        const taskName = interaction.options.getString('task') || '未設定';
        const now = Date.now();

        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // 💡 FOR UPDATE でレコードをロックし、同時操作による重複作成を防止
            const result = await client.query(
                `SELECT * FROM study_intervals WHERE user_id = $1 AND status IN ('active', 'paused') LIMIT 1 FOR UPDATE`,
                [userId]
            );
            const current = result.rows[0];

            if (current) {
                if (current.status === 'active') {
                    await client.query('ROLLBACK');
                    return interaction.editReply({ content: '現在すでに作業中です。終了するか一時停止してください。' });
                }

                if (current.status === 'paused') {
                    // 一時停止からの再開処理
                    const pauseStart = Number(current.pause_start_time);
                    const additionalPausedTime = now - pauseStart;
                    
                    await client.query(
                        `UPDATE study_intervals 
                         SET status = 'active', total_paused_time = total_paused_time + $1, last_checked_at = $2 
                         WHERE id = $3`,
                        [additionalPausedTime, now, current.id]
                    );

                    await client.query('COMMIT');

                    const embed = new EmbedBuilder()
                        .setTitle('▶️ 作業再開')
                        .setDescription('一時停止を解除し、記録を再開しました。')
                        .addFields(
                            { name: '科目', value: resolveSubjectName(current.subject), inline: true },
                            { name: '作業内容', value: current.task_name, inline: true }
                        )
                        .setColor(resolveSubjectColor(current.subject))
                        .setTimestamp();

                    return interaction.editReply({ embeds: [embed] });
                }
            }

            // 新規作業の開始処理
            await client.query(
                `INSERT INTO study_intervals (user_id, task_name, subject, start_time, status, last_checked_at, total_paused_time)
                 VALUES ($1, $2, $3, $4, 'active', $5, 0)`,
                [userId, taskName, subject, now, now]
            );

            await client.query('COMMIT');

            const embed = new EmbedBuilder()
                .setTitle('🚀 作業開始')
                .addFields(
                    { name: '科目', value: resolveSubjectName(subject), inline: true },
                    { name: '作業内容', value: taskName, inline: true }
                )
                .setColor(resolveSubjectColor(subject))
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (err) {
            await client.query('ROLLBACK').catch(() => null);
            console.error('[Start Cmd Error]', err);
            await interaction.editReply({ content: '作業の開始中にエラーが発生しました。' }).catch(() => null);
        } finally {
            client.release();
        }
    }
};