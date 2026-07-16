const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database/db');
const { resolveSubjectColor, resolveSubjectName } = require('../utils/timeHelper');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('edit')
        .setDescription('過去の記録を追加・修正・削除')
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
                    { name: 'その他', value: 'other' },
                    { name: '削除', value: 'delete' }
                )
        )
        .addStringOption(option =>
            option.setName('start')
                .setDescription('開始時刻 HH:MM')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('end')
                .setDescription('終了時刻 HH:MM')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('date')
                .setDescription('日付 YYYY-MM-DD または MM-DD (省略時は今日)')
                .setRequired(false)
        ),

    async execute(interaction) {
        const subject = interaction.options.getString('subject');
        const startText = interaction.options.getString('start');
        const endText = interaction.options.getString('end');
        const dateText = interaction.options.getString('date');

        const startParts = startText.split(':');
        const endParts = endText.split(':');

        if (startParts.length !== 2 || endParts.length !== 2) {
            return interaction.reply({ content: '時刻は HH:MM 形式で入力してください', ephemeral: true });
        }

        // 💡 .env の TZ="Asia/Tokyo" のおかげで、new Date() は自然にJSTとして振る舞います
        let targetDate = new Date();

        if (dateText) {
            let parsedDateText = dateText.replace(/\//g, '-');
            if (parsedDateText.split('-').length === 2) {
                parsedDateText = `${targetDate.getFullYear()}-${parsedDateText}`;
            }

            const parsed = new Date(parsedDateText);
            if (isNaN(parsed.getTime())) {
                return interaction.reply({ content: '無効な日付です。YYYY-MM-DD または MM-DD 形式で入力してください。', ephemeral: true });
            }
            targetDate = parsed;
        } else {
            // 深夜0〜1時の間は、日付指定なしなら前日分として扱う
            const currentHour = targetDate.getHours();
            if (currentHour < 2) {
                targetDate.setDate(targetDate.getDate() - 1);
            }
        }

        const start = new Date(targetDate);
        start.setHours(Number(startParts[0]), Number(startParts[1]), 0, 0);

        const end = new Date(targetDate);
        end.setHours(Number(endParts[0]), Number(endParts[1]), 0, 0);

        // 💡 終了時刻が開始時刻より前の場合、日を跨いだと判断して日付を翌日に進める
        if (end <= start) {
            end.setDate(end.getDate() + 1);
        }

        const startMs = start.getTime();
        const endMs = end.getTime();
        const userId = interaction.user.id;

        await interaction.deferReply();
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // 既存の完了ログとの重複を検知
            const overlap = await client.query(`
                SELECT id, user_id, task_name, subject, start_time, end_time, total_paused_time
                FROM study_intervals
                WHERE user_id = $1 
                  AND status = 'completed'
                  AND start_time < $3 
                  AND (end_time > $2 OR end_time IS NULL)
            `, [userId, startMs, endMs]);

            // 重複部分のトリミング処理
            for (const row of overlap.rows) {
                await client.query(`DELETE FROM study_intervals WHERE id = $1`, [row.id]);

                const rowStart = Number(row.start_time);
                const rowEnd = Number(row.end_time);
                const pausedTime = Number(row.total_paused_time || 0);

                // 被ったログの前半部分を再挿入
                if (rowStart < startMs) {
                    const newTotal = Math.max(0, startMs - rowStart - pausedTime);
                    await client.query(`
                        INSERT INTO study_intervals (user_id, task_name, subject, start_time, end_time, total_time, status, total_paused_time)
                        VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)
                    `, [row.user_id, row.task_name, row.subject, rowStart, startMs, newTotal, pausedTime]);
                }

                // 被ったログの後半部分を再挿入
                if (rowEnd && rowEnd > endMs) {
                    const newTotal = Math.max(0, rowEnd - endMs);
                    await client.query(`
                        INSERT INTO study_intervals (user_id, task_name, subject, start_time, end_time, total_time, status, total_paused_time)
                        VALUES ($1, $2, $3, $4, $5, $6, 'completed', 0)
                    `, [row.user_id, row.task_name, row.subject, endMs, rowEnd, newTotal]);
                }
            }

            // 削除コマンド以外なら新規ログを挿入
            if (subject !== 'delete') {
                const totalTime = endMs - startMs;
                await client.query(`
                    INSERT INTO study_intervals (user_id, task_name, subject, start_time, end_time, total_time, status)
                    VALUES ($1, $2, $3, $4, $5, $6, 'completed')
                `, [userId, '手動追加', subject, startMs, endMs, totalTime]);
            }

            await client.query('COMMIT');

            // Discord用の日付表示テキスト生成
            const yyyy = targetDate.getFullYear();
            const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
            const dd = String(targetDate.getDate()).padStart(2, '0');
            const dateDisplay = `${yyyy}/${mm}/${dd}`;

            const embedColor = subject === 'delete' ? '#FF0000' : resolveSubjectColor(subject);
            const embed = new EmbedBuilder()
                .setTitle('✅ 記録編集完了')
                .addFields(
                    { name: '日付', value: dateDisplay, inline: false },
                    { name: '科目', value: subject === 'delete' ? '🗑️ 削除' : resolveSubjectName(subject), inline: true },
                    { name: '開始', value: startText, inline: true },
                    { name: '終了', value: endText, inline: true }
                )
                .setColor(embedColor)
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

            // 必要であればランキングシステム等のアップデート関数をここで呼ぶ
            if (interaction.client.rankingSystem && typeof interaction.client.rankingSystem.update === 'function') {
                interaction.client.rankingSystem.update();
            }

        } catch (err) {
            await client.query('ROLLBACK').catch(() => null);
            console.error('[Edit Cmd Error]', err);
            await interaction.editReply({ content: '編集中にエラーが発生しました' }).catch(() => null);
        } finally {
            client.release();
        }
    }
};