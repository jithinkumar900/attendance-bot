require('dotenv').config();
const { App } = require('@slack/bolt');
const cron = require('node-cron');
const Database = require('./database');
const Utils = require('./utils');

// Configuration from environment variables (fallback to defaults)
const config = {
    bot: {
        maxUnplannedHours: parseFloat(process.env.MAX_UNPLANNED_HOURS) || 2.5,
        workingHoursPerDay: parseFloat(process.env.WORKING_HOURS_PER_DAY) || 8,
        extraWorkDeadlineDays: parseInt(process.env.EXTRA_WORK_DEADLINE_DAYS) || 7,
        adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
        transparencyChannel: process.env.TRANSPARENCY_CHANNEL || '#unplanned-leave',
        halfDayFormUrl: process.env.HALF_DAY_FORM_URL || 'https://forms.google.com/your-half-day-form-link'
    },
    notifications: {
        notifyUsers: process.env.NOTIFY_USERS ? process.env.NOTIFY_USERS.split(',') : ['@hr-team', '@manager'],
        notifyChannels: process.env.NOTIFY_CHANNELS ? process.env.NOTIFY_CHANNELS.split(',') : ['#hr-notifications'],
        hourlyPrompts: process.env.HOURLY_PROMPTS !== 'false',
        dailySummary: process.env.DAILY_SUMMARY !== 'false',
        weeklyReminders: process.env.WEEKLY_REMINDERS !== 'false'
    }
};

// Initialize the app
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    port: process.env.PORT || 3000
});

// Initialize database
const db = new Database(process.env.DATABASE_PATH);

// Store active extra work prompts to avoid duplicates
const activePrompts = new Map();

// ================================
// SLASH COMMANDS
// ================================

// Start unplanned leave
app.command('/unplanned', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
        const { user_id, text, channel_id } = command;
        
        if (!text.trim()) {
            await say({
                text: "Please provide duration and reason. Example: `/unplanned 1.5h doctor appointment`",
                response_type: 'ephemeral'
            });
            return;
        }

        // Parse the input
        const parts = text.trim().split(' ');
        const durationStr = parts[0];
        const reason = parts.slice(1).join(' ');

        if (!reason) {
            await say({
                text: "Please provide a reason. Example: `/unplanned 1.5h doctor appointment`",
                response_type: 'ephemeral'
            });
            return;
        }

        // Validate duration
        if (!Utils.isValidDuration(durationStr)) {
            await say({
                text: "Invalid duration format. Use formats like: 1h, 1.5h, 30m, 1h30m",
                response_type: 'ephemeral'
            });
            return;
        }

        // Check if user already has an active leave session
        const activeSession = await db.getUserActiveLeaveSession(user_id);
        if (activeSession) {
            await say({
                text: `You already have an active leave session. Use \`/return\` first.`,
                response_type: 'ephemeral'
            });
            return;
        }

        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        // Create user in database if not exists
        await db.createUser(user_id, userName, userInfo.user.profile.email);

        // Parse duration and calculate return time
        const durationMinutes = Utils.parseDuration(durationStr);
        const returnTime = Utils.calculateReturnTime(durationMinutes);
        const formattedDuration = Utils.formatDuration(durationMinutes);

        // Start leave session
        await db.startLeaveSession(user_id, durationMinutes, reason);

        // Send transparency message to the configured channel
        const message = Utils.formatLeaveTransparencyMessage(userName, formattedDuration, reason, returnTime);
        
        await client.chat.postMessage({
            channel: config.bot.transparencyChannel,
            text: message
        });

        // Confirm to user
        await say({
            text: `✅ Leave started! Duration: ${formattedDuration}. Expected return: ${returnTime}`,
            response_type: 'ephemeral'
        });

        // Notify configured users/channels
        for (const user of config.notifications.notifyUsers) {
            try {
                await client.chat.postMessage({
                    channel: user,
                    text: `📋 **Leave Notification**\n${message}`
                });
            } catch (error) {
                console.error(`Failed to notify ${user}:`, error);
            }
        }

    } catch (error) {
        console.error('Error in unplanned:', error);
        await say({
            text: "Sorry, there was an error starting your leave session. Please try again.",
            response_type: 'ephemeral'
        });
    }
});

// End unplanned leave
app.command('/return', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
        const { user_id } = command;

        // End the leave session
        const session = await db.endLeaveSession(user_id);
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        const actualDuration = Utils.formatDuration(session.actualDuration);

        // Send transparency message
        const message = Utils.formatLeaveEndMessage(userName, actualDuration);
        
        await client.chat.postMessage({
            channel: config.bot.transparencyChannel,
            text: message
        });

        // Update daily summary
        const today = Utils.getCurrentDate();
        const summary = await db.updateDailySummary(user_id, today);

        // Check if total leave exceeds threshold
        if (Utils.exceedsThreshold(summary.totalLeave, config.bot.maxUnplannedHours)) {
            const totalLeaveFormatted = Utils.formatDuration(summary.totalLeave);
            const halfDayMessage = Utils.formatHalfDayMessage(totalLeaveFormatted, config.bot.halfDayFormUrl);
            
            await say({
                text: halfDayMessage,
                response_type: 'ephemeral'
            });
        }

        // Confirm to user
        await say({
            text: `✅ Leave ended! Actual duration: ${actualDuration}`,
            response_type: 'ephemeral'
        });

    } catch (error) {
        console.error('Error in return:', error);
        if (error.message.includes('No active leave session')) {
            await say({
                text: "You don't have an active leave session to end.",
                response_type: 'ephemeral'
            });
        } else {
            await say({
                text: "Sorry, there was an error ending your leave session. Please try again.",
                response_type: 'ephemeral'
            });
        }
    }
});

// Start extra work
app.command('/work-start', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
        const { user_id, text = 'Compensating unplanned leave' } = command;

        // Check if user already has an active extra work session
        const activeSession = await db.getUserActiveExtraWorkSession(user_id);
        if (activeSession) {
            await say({
                text: `You already have an active extra work session. Use \`/work-end\` first.`,
                response_type: 'ephemeral'
            });
            return;
        }

        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        // Start extra work session
        await db.startExtraWorkSession(user_id, text);

        await say({
            text: `⏰ Extra work session started! You'll be prompted every hour.`,
            response_type: 'ephemeral'
        });

        // Schedule hourly prompts
        scheduleExtraWorkPrompts(user_id, client);

    } catch (error) {
        console.error('Error in work-start:', error);
        await say({
            text: "Sorry, there was an error starting your extra work session. Please try again.",
            response_type: 'ephemeral'
        });
    }
});

// End extra work
app.command('/work-end', async ({ command, ack, say }) => {
    await ack();
    
    try {
        const { user_id } = command;

        // End the extra work session
        const session = await db.endExtraWorkSession(user_id);
        const duration = Utils.formatDuration(session.duration);

        // Update daily summary
        const today = Utils.getCurrentDate();
        await db.updateDailySummary(user_id, today);

        // Clear any active prompts
        if (activePrompts.has(user_id)) {
            clearTimeout(activePrompts.get(user_id));
            activePrompts.delete(user_id);
        }

        await say({
            text: `✅ Extra work session ended! Duration: ${duration}`,
            response_type: 'ephemeral'
        });

    } catch (error) {
        console.error('Error in work-end:', error);
        if (error.message.includes('No active extra work session')) {
            await say({
                text: "You don't have an active extra work session to end.",
                response_type: 'ephemeral'
            });
        } else {
            await say({
                text: "Sorry, there was an error ending your extra work session. Please try again.",
                response_type: 'ephemeral'
            });
        }
    }
});

// Check leave balance
app.command('/review', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
        const { user_id } = command;
        const today = Utils.getCurrentDate();
        
        const summary = await db.getUserDailySummary(user_id, today);
        
        if (!summary) {
            await say({
                text: "📊 **Today's Summary**\n• No leave taken today\n• No extra work needed\n✅ **All good!**",
                response_type: 'ephemeral'
            });
            return;
        }

        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;
        
        const summaryMessage = Utils.formatUserDailySummary(summary, userName);
        
        await say({
            text: summaryMessage,
            response_type: 'ephemeral'
        });

    } catch (error) {
        console.error('Error in review:', error);
        await say({
            text: "Sorry, there was an error retrieving your balance. Please try again.",
            response_type: 'ephemeral'
        });
    }
});

// Admin command
app.command('/admin', async ({ command, ack, say }) => {
    await ack();
    
    try {
        const { user_id, text } = command;
        
        if (!text || !Utils.validateAdminPassword(text.trim(), config.bot.adminPassword)) {
            await say({
                text: "❌ Invalid admin password.",
                response_type: 'ephemeral'
            });
            return;
        }

        // Generate report for the last 30 days
        const endDate = Utils.getCurrentDate();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        const startDateStr = startDate.toISOString().split('T')[0];

        const reportData = await db.getAdminReport(startDateStr, endDate);
        const report = Utils.formatAdminReport(reportData, startDateStr, endDate);

        await say({
            text: report,
            response_type: 'ephemeral'
        });

    } catch (error) {
        console.error('Error in admin command:', error);
        await say({
            text: "Sorry, there was an error generating the admin report. Please try again.",
            response_type: 'ephemeral'
        });
    }
});

// ================================
// EXTRA WORK PROMPTS
// ================================

function scheduleExtraWorkPrompts(userId, client) {
    const promptUser = async () => {
        try {
            // Check if session is still active
            const activeSession = await db.getUserActiveExtraWorkSession(userId);
            if (!activeSession) {
                activePrompts.delete(userId);
                return;
            }

            const startTime = new Date(activeSession.start_time);
            const currentDuration = Utils.calculateActualDuration(activeSession.start_time, new Date());
            const formattedDuration = Utils.formatDuration(currentDuration);

            const message = Utils.formatExtraWorkPrompt(formattedDuration);

            const result = await client.chat.postMessage({
                channel: userId,
                text: message,
                blocks: [
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: message
                        }
                    },
                    {
                        type: "actions",
                        elements: [
                            {
                                type: "button",
                                text: {
                                    type: "plain_text",
                                    text: "✅ Continue Working"
                                },
                                action_id: "extra_work_continue",
                                value: userId,
                                style: "primary"
                            },
                            {
                                type: "button",
                                text: {
                                    type: "plain_text",
                                    text: "❌ Stop Working"
                                },
                                action_id: "extra_work_stop",
                                value: userId,
                                style: "danger"
                            }
                        ]
                    }
                ]
            });

            // Schedule next prompt in 1 hour
            const timeoutId = setTimeout(() => promptUser(), 60 * 60 * 1000); // 1 hour
            activePrompts.set(userId, timeoutId);

        } catch (error) {
            console.error('Error in extra work prompt:', error);
            activePrompts.delete(userId);
        }
    };

    // Start first prompt in 1 hour
    const timeoutId = setTimeout(() => promptUser(), 60 * 60 * 1000); // 1 hour
    activePrompts.set(userId, timeoutId);
}

// ================================
// BUTTON INTERACTIONS
// ================================

// Handle extra work continue button
app.action('extra_work_continue', async ({ body, ack, say }) => {
    await ack();
    
    try {
        const userId = body.actions[0].value;
        
        await say({
            text: "⏰ Got it! Keep up the good work. I'll check again in an hour.",
            response_type: 'ephemeral'
        });

    } catch (error) {
        console.error('Error in extra work continue:', error);
    }
});

// Handle extra work stop button
app.action('extra_work_stop', async ({ body, ack, say }) => {
    await ack();
    
    try {
        const userId = body.actions[0].value;
        
        // End the extra work session
        const session = await db.endExtraWorkSession(userId);
        const duration = Utils.formatDuration(session.duration);

        // Update daily summary
        const today = Utils.getCurrentDate();
        await db.updateDailySummary(userId, today);

        // Clear prompts
        if (activePrompts.has(userId)) {
            clearTimeout(activePrompts.get(userId));
            activePrompts.delete(userId);
        }

        await say({
            text: `✅ Extra work session ended! Total duration: ${duration}`,
            response_type: 'ephemeral'
        });

    } catch (error) {
        console.error('Error in extra work stop:', error);
    }
});

// ================================
// SCHEDULED TASKS
// ================================

// End of day summary (6 PM weekdays)
cron.schedule('0 18 * * 1-5', async () => {
    try {
        console.log('Running end-of-day summary...');
        
        const today = Utils.getCurrentDate();
        const allUsers = await db.getAllUsersWithPendingWork(0); // Get all users for today
        
        for (const user of allUsers) {
            try {
                const summary = await db.getUserDailySummary(user.id, today);
                if (summary && (summary.total_leave_minutes > 0 || summary.pending_extra_work_minutes > 0)) {
                    
                    const userInfo = await app.client.users.info({ user: user.id });
                    const userName = userInfo.user.real_name || userInfo.user.name;
                    
                    const summaryMessage = Utils.formatUserDailySummary(summary, userName);
                    
                    await app.client.chat.postMessage({
                        channel: user.id,
                        text: `🌅 **End of Day Summary**\n\n${summaryMessage}`
                    });
                }
            } catch (error) {
                console.error(`Error sending summary to user ${user.id}:`, error);
            }
        }
        
    } catch (error) {
        console.error('Error in end-of-day summary:', error);
    }
});

// Weekly reminder for pending extra work (Monday 9 AM)
cron.schedule('0 9 * * 1', async () => {
    try {
        console.log('Running weekly reminder...');
        
        const usersWithPendingWork = await db.getAllUsersWithPendingWork(7);
        
        for (const user of usersWithPendingWork) {
            try {
                const pendingTime = Utils.formatDuration(user.pending_extra_work_minutes);
                const daysAgo = Utils.getWorkingDaysBetween(user.date, Utils.getCurrentDate());
                
                await app.client.chat.postMessage({
                    channel: user.id,
                    text: `⚠️ **Weekly Reminder**\n\nYou have ${pendingTime} of pending extra work from ${daysAgo} day(s) ago.\nPlease use \`/work-start\` to log your extra work time.`
                });
                
            } catch (error) {
                console.error(`Error sending reminder to user ${user.id}:`, error);
            }
        }
        
    } catch (error) {
        console.error('Error in weekly reminder:', error);
    }
});

// ================================
// APP START
// ================================

(async () => {
    try {
        // Start your app
        await app.start();
        console.log('⚡️ Attendance Bot is running!');
        console.log('📍 Configuration:');
        console.log(`  • Max unplanned hours: ${config.bot.maxUnplannedHours}h`);
        console.log(`  • Transparency channel: ${config.bot.transparencyChannel}`);
        console.log(`  • Admin password set: ${config.bot.adminPassword ? '✅' : '❌'}`);
        console.log(`  • Half-day form: ${config.bot.halfDayFormUrl}`);
        console.log('🚀 Available commands:');
        console.log('  /unplanned <duration> <reason> - Start unplanned leave');
        console.log('  /return - End current leave');
        console.log('  /work-start [reason] - Start extra work session');
        console.log('  /work-end - End extra work session');
        console.log('  /review - Check today\'s summary');
        console.log('  /admin <password> - Admin report');
        
    } catch (error) {
        console.error('Error starting the app:', error);
        process.exit(1);
    }
})();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down bot...');
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down bot...');
    db.close();
    process.exit(0);
}); 