const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const { resolveSubjectColor, formatTime } = require('../utils/timelineHelper');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('作業終了'),

    async execute(interaction) {
        await interaction.deferReply();
        const userId = interaction.user.id;
        const now = Date.now();

        try {
            const result = await db.query(
                `SELECT * FROM study_intervals WHERE user_id = $1 AND status IN ('active', 'paused') LIMIT 1`,
                [userId]
            );
            const current = result.rows[0];

            if (!current) {
                return interaction.editReply({ content: '対象の作業レコードが存在しません。' });
            }

            let additionalPause = 0;
            if (current.status === 'paused') {
                additionalPause = now - Number(current.pause_start_time);
            }

            const finalTotalPaused = Number(current.total_paused_time) + additionalPause;
            const totalTime = Math.max(0, now - Number(current.start_time) - finalTotalPaused);

            await db.query(`
                UPDATE study_intervals
                SET end_time = $1, total_time = $2, status = 'completed', 
                    total_paused_time = $3, pause_start_time = NULL, last_checked_at = NULL
                WHERE id = $4
            `, [now, totalTime, finalTotalPaused, current.id]);

            const embed = new EmbedBuilder()
                .setTitle('作業終了')
                .addFields(
                    { name: '作業名', value: current.task_name || '未設定', inline: true },
                    { name: '時間', value: formatTime(totalTime), inline: true }
                )
                .setColor(resolveSubjectColor(current.subject));

            await interaction.editReply({ embeds: [embed] });

        } catch (err) {
            console.error(err);
            await interaction.editReply({ content: 'システムエラーが発生しました。' });
        }
    }
};