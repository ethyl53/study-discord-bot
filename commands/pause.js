const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const { resolveSubjectColor } = require('../utils/timeHelper');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pause')
        .setDescription('作業一時停止'),

    async execute(interaction) {
        await interaction.deferReply();
        const userId = interaction.user.id;
        const now = Date.now();

        try {
            const result = await db.query(
                `SELECT id, task_name, subject, status FROM study_intervals WHERE user_id = $1 AND status IN ('active', 'paused') LIMIT 1`,
                [userId]
            );
            const current = result.rows[0];

            if (!current) {
                return interaction.editReply({ content: '対象の作業レコードが存在しません。' });
            }

            if (current.status === 'paused') {
                return interaction.editReply({ content: '既に一時停止状態です。' });
            }

            await db.query(`
                UPDATE study_intervals
                SET status = 'paused', pause_start_time = $1
                WHERE id = $2
            `, [now, current.id]);

            const embed = new EmbedBuilder()
                .setTitle('作業一時停止')
                .addFields({ name: '作業名', value: current.task_name || '未設定' })
                .setColor(resolveSubjectColor(current.subject));

            await interaction.editReply({ embeds: [embed] });

        } catch (err) {
            console.error(err);
            await interaction.editReply({ content: 'システムエラーが発生しました。' });
        }
    }
};