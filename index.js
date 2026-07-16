const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
require('dotenv').config();

const db = require('./database/db'); // ボタン処理用にDBをインポート
const { initMonitor } = require('./utils/monitor');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages
    ]
});

client.commands = new Collection();
const commandsData = [];

// コマンドファイルの動的読み込み
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        commandsData.push(command.data.toJSON());
    } else {
        console.log(`[WARNING] ${filePath} に必要な data または execute が不足しています。`);
    }
}

client.once('ready', async () => {
    console.log(`System Online: ${client.user.tag}`);
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commandsData }
        );
        console.log('Commands synchronized successfully.');
    } catch (error) {
        console.error('Command Sync Error:', error);
    }

    // 監視システムの起動
    initMonitor(client);
});

client.on('interactionCreate', async interaction => {
    // 💡 監視システムからの「継続」ボタン処理
    if (interaction.isButton()) {
        if (interaction.customId.startsWith('keep_working_')) {
            const targetUserId = interaction.customId.replace('keep_working_', '');
            
            // 他人のボタン操作を弾く
            if (interaction.user.id !== targetUserId) {
                return interaction.reply({ content: '他人の作業状態は変更できません。', ephemeral: true });
            }

            try {
                // 生存監視基準時間(last_checked_at)を現在時刻に更新してタイマーリセット
                await db.query(
                    `UPDATE study_intervals SET last_checked_at = $1 WHERE user_id = $2 AND status = 'active'`,
                    [Date.now(), targetUserId]
                );
                return interaction.reply({ content: '作業の継続を確認しました。引き続き頑張ってください！', ephemeral: true });
            } catch (err) {
                console.error('Button Check Error:', err);
                return interaction.reply({ content: 'エラーが発生しました。', ephemeral: true });
            }
        }
        return;
    }

    // スラッシュコマンドの処理
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        const replyPayload = { content: 'コマンド実行中にエラーが発生しました。', ephemeral: true };
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(replyPayload).catch(() => null);
        } else {
            await interaction.reply(replyPayload).catch(() => null);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);