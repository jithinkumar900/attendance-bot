require('dotenv').config();
const { App } = require('@slack/bolt');
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
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
// KEEPALIVE MECHANISM (Prevent Render Spin-Down)
// ================================

// Create Express server for HTTP endpoints (separate from Slack Socket Mode)
const expressApp = express();
const PORT = process.env.PORT || 3000;

// Simple HTTP endpoint for health checks and Render port binding
expressApp.get('/', (req, res) => {
    res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        message: 'Attendance bot is running!',
        timezone: 'Asia/Kolkata',
        keepalive: RENDER_URL ? 'enabled' : 'disabled'
    });
});

expressApp.get('/ping', (req, res) => {
    res.status(200).json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        message: 'Attendance bot is running!' 
    });
});

expressApp.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy',
        service: 'attendance-bot',
        timestamp: new Date().toISOString()
    });
});

// Start Express server
expressApp.listen(PORT, () => {
    console.log(`🌐 HTTP server running on port ${PORT}`);
});

// Self-ping every 10 minutes to prevent spin-down
const RENDER_URL = process.env.RENDER_URL; // We'll add this as env var

if (RENDER_URL) {
    cron.schedule('*/10 * * * *', async () => {
        try {
            await axios.get(`${RENDER_URL}/ping`, { timeout: 5000 });
            console.log('🔄 Keepalive ping successful');
        } catch (error) {
            console.log('⚠️ Keepalive ping failed (normal if service is spinning up)');
        }
    });
}

// ================================
// SLASH COMMANDS
// ================================

// Start unplanned leave - Interactive Modal
app.command('/unplanned', async ({ command, ack, client }) => {
    await ack();
    
    try {
        const { user_id, trigger_id } = command;

        // Check if user already has an active leave session
        const activeSession = await db.getUserActiveLeaveSession(user_id);
        if (activeSession) {
            await client.views.open({
                trigger_id,
                view: {
                    type: 'modal',
                    callback_id: 'leave_error_modal',
                    title: { type: 'plain_text', text: 'Already on Leave' },
                    close: { type: 'plain_text', text: 'Close' },
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: '⚠️ *You already have an active leave session.*\n\nPlease use `/return` first to end your current session before starting a new one.'
                            }
                        }
                    ]
                }
            });
            return;
        }

        // Open interactive modal
        await client.views.open({
            trigger_id,
            view: {
                type: 'modal',
                callback_id: 'unplanned_leave_modal',
                title: { type: 'plain_text', text: 'Start Unplanned Leave' },
                submit: { type: 'plain_text', text: 'Start Leave' },
                close: { type: 'plain_text', text: 'Cancel' },
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '⏰ *How long will you be away?*\n\nSelect your expected leave duration:'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'leave_hours',
                        element: {
                            type: 'static_select',
                            placeholder: { type: 'plain_text', text: 'Select hours' },
                            action_id: 'hours_select',
                            options: [
                                { text: { type: 'plain_text', text: '0 hours' }, value: '0' },
                                { text: { type: 'plain_text', text: '1 hour' }, value: '1' },
                                { text: { type: 'plain_text', text: '2 hours' }, value: '2' },
                                { text: { type: 'plain_text', text: '3 hours' }, value: '3' },
                                { text: { type: 'plain_text', text: '4 hours' }, value: '4' },
                                { text: { type: 'plain_text', text: '5 hours' }, value: '5' },
                                { text: { type: 'plain_text', text: '6 hours' }, value: '6' },
                                { text: { type: 'plain_text', text: '7 hours' }, value: '7' },
                                { text: { type: 'plain_text', text: '8 hours' }, value: '8' }
                            ],
                            initial_option: { text: { type: 'plain_text', text: '0 hours' }, value: '0' }
                        },
                        label: { type: 'plain_text', text: '🕐 Hours' }
                    },
                    {
                        type: 'input',
                        block_id: 'leave_minutes',
                        element: {
                            type: 'static_select',
                            placeholder: { type: 'plain_text', text: 'Select minutes' },
                            action_id: 'minutes_select',
                            options: [
                                { text: { type: 'plain_text', text: '0 minutes' }, value: '0' },
                                { text: { type: 'plain_text', text: '15 minutes' }, value: '15' },
                                { text: { type: 'plain_text', text: '30 minutes' }, value: '30' },
                                { text: { type: 'plain_text', text: '45 minutes' }, value: '45' }
                            ],
                            initial_option: { text: { type: 'plain_text', text: '15 minutes' }, value: '15' }
                        },
                        label: { type: 'plain_text', text: '⏰ Minutes' }
                    },
                    {
                        type: 'input',
                        block_id: 'leave_reason',
                        optional: true,
                        element: {
                            type: 'plain_text_input',
                            action_id: 'reason_input',
                            placeholder: { type: 'plain_text', text: 'Optional: Quick coffee, Doctor visit, etc.' },
                            max_length: 100
                        },
                        label: { type: 'plain_text', text: '📝 Reason (optional)' }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '💡 *This will be posted to #unplanned-leave for transparency*'
                            }
                        ]
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Error in unplanned modal:', error);
        // Fallback to simple message - Force restart v2
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "Sorry, there was an error opening the leave form. Please try again."
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
        const plannedDuration = Utils.formatDuration(session.planned_duration);

        // Check if actual time exceeded planned time
        if (session.actualDuration > session.planned_duration) {
            const exceededBy = Utils.formatDuration(session.actualDuration - session.planned_duration);
            
            // Send DM about time exceeded
            await client.chat.postMessage({
                channel: user_id,
                text: `😊 *Time Summary*\n\nHi! You planned to be away for *${plannedDuration}* but were actually away for *${actualDuration}*.\nExtra time taken: *${exceededBy}*\n\n🔄 *Next Steps:*\n1. Use \`/work-start\` to begin ${exceededBy} of extra work\n2. I'll help track your progress and auto-complete when done!\n\nThanks for being transparent! 🙏`
            });
        }

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
            
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: user_id,
                text: halfDayMessage
            });
        }

        // Confirm to user (private)
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: user_id,
            text: `✅ Leave ended! Actual duration: ${actualDuration}`
        });

    } catch (error) {
        console.error('Error in return:', error);
        if (error.message.includes('No active leave session')) {
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: "You don't have an active leave session to end."
            });
        } else {
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: "Sorry, there was an error ending your leave session. Please try again."
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
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: user_id,
                text: `You already have an active extra work session. Use \`/work-end\` first.`
            });
            return;
        }

        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        // Start extra work session
        await db.startExtraWorkSession(user_id, text);

        // Post public message about extra work start
        await say({
            text: `⏰ *${userName}* started extra work session to compensate for unplanned leave.`
        });

        // Send private confirmation to user
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: user_id,
            text: `⏰ *Extra work session started!*\n\nI'll check on you every hour and auto-complete when you've worked enough time. Good luck! 💪`
        });

        // Schedule hourly prompts
        scheduleExtraWorkPrompts(user_id, client);

    } catch (error) {
        console.error('Error in work-start:', error);
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "Sorry, there was an error starting your extra work session. Please try again."
        });
    }
});

// End extra work
app.command('/work-end', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
        const { user_id } = command;

        // End the extra work session
        const session = await db.endExtraWorkSession(user_id);
        const duration = Utils.formatDuration(session.duration);

        // Get user info for public message
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        // Update daily summary
        const today = Utils.getCurrentDate();
        await db.updateDailySummary(user_id, today);

        // Clear any active prompts
        if (activePrompts.has(user_id)) {
            clearTimeout(activePrompts.get(user_id));
            activePrompts.delete(user_id);
        }

        // Post public message about extra work completion
        await say({
            text: `✅ *${userName}* completed extra work session. Duration: ${duration}`
        });

        // Send private confirmation to user
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: user_id,
            text: `✅ *Extra work session completed!*\n\nDuration: ${duration}\nGreat job! 🎉`
        });

    } catch (error) {
        console.error('Error in work-end:', error);
        if (error.message.includes('No active extra work session')) {
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: "You don't have an active extra work session to end."
            });
        } else {
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: "Sorry, there was an error ending your extra work session. Please try again."
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
        
        // Check for active sessions first
        const activeLeave = await db.getUserActiveLeaveSession(user_id);
        const activeExtraWork = await db.getUserActiveExtraWorkSession(user_id);
        
        // Get completed summary
        const summary = await db.getUserDailySummary(user_id, today);
        
        // Build status message
        let statusMessage = "📊 *Today's Status*\n\n";
        
        // Add active sessions info
        if (activeLeave) {
            const plannedDuration = Utils.formatDuration(activeLeave.planned_duration);
            const currentDuration = Math.round((new Date() - new Date(activeLeave.start_time)) / (1000 * 60));
            const actualDuration = Utils.formatDuration(currentDuration);
            const exceeded = currentDuration > activeLeave.planned_duration;
            
            statusMessage += `🔴 *ACTIVE LEAVE SESSION*\n`;
            statusMessage += `• Planned: ${plannedDuration}\n`;
            statusMessage += `• Current: ${actualDuration} ${exceeded ? '⚠️ *EXCEEDED*' : ''}\n`;
            statusMessage += `• Reason: ${activeLeave.reason}\n\n`;
        }
        
        if (activeExtraWork) {
            const currentDuration = Math.round((new Date() - new Date(activeExtraWork.start_time)) / (1000 * 60));
            const actualDuration = Utils.formatDuration(currentDuration);
            
            statusMessage += `🟢 *ACTIVE EXTRA WORK SESSION*\n`;
            statusMessage += `• Duration: ${actualDuration}\n`;
            statusMessage += `• Reason: ${activeExtraWork.reason}\n\n`;
        }
        
        // Add completed summary
        if (summary && (summary.total_leave_minutes > 0 || summary.total_extra_work_minutes > 0)) {
            const userInfo = await client.users.info({ user: user_id });
            const userName = userInfo.user.real_name || userInfo.user.name;
            statusMessage += `📈 *Completed Today*\n`;
            statusMessage += `• Leave: ${Utils.formatDuration(summary.total_leave_minutes)}\n`;
            statusMessage += `• Extra Work: ${Utils.formatDuration(summary.total_extra_work_minutes)}\n`;
            statusMessage += `• Pending: ${Utils.formatDuration(summary.pending_extra_work_minutes)}\n`;
        }
        
        // If no activity at all
        if (!activeLeave && !activeExtraWork && (!summary || (summary.total_leave_minutes === 0 && summary.total_extra_work_minutes === 0))) {
            statusMessage += "✅ *All good! No leave or extra work today.*";
        }
        
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: user_id,
            text: statusMessage
        });

    } catch (error) {
        console.error('Error in review:', error);
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "Sorry, there was an error retrieving your status. Please try again."
        });
    }
});

// Admin command - Interactive Dashboard
app.command('/admin', async ({ command, ack, say, client }) => {
    await ack();
    
    try {
        const { user_id, text } = command;
        
        if (!text || !Utils.validateAdminPassword(text.trim(), config.bot.adminPassword)) {
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: user_id,
                text: "❌ Invalid admin password."
            });
            return;
        }

        // Get live status data
        const liveStatus = await getLiveAdminStatus();
        const dashboardMessage = Utils.formatAdminDashboard(liveStatus);

        // Use client.chat.postEphemeral to ensure privacy
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: user_id,
            text: dashboardMessage.text,
            blocks: dashboardMessage.blocks
        });

    } catch (error) {
        console.error('Error in admin command:', error);
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: user_id,
            text: "Sorry, there was an error loading the admin dashboard. Please try again."
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

            // Check if enough work has been completed (get today's pending work)
            const today = Utils.getCurrentDate();
            const summary = await db.getUserDailySummary(userId, today);
            
            if (summary && currentDuration >= summary.pending_extra_work_minutes) {
                // Auto-complete the work session
                try {
                    const session = await db.endExtraWorkSession(userId);
                    const duration = Utils.formatDuration(session.duration);

                    // Update daily summary
                    await db.updateDailySummary(userId, today);

                    // Clear prompts
                    if (activePrompts.has(userId)) {
                        clearTimeout(activePrompts.get(userId));
                        activePrompts.delete(userId);
                    }

                    // Send completion message
                    await client.chat.postMessage({
                        channel: userId,
                        text: `🎉 *Extra Work Completed!*\n\nAwesome! You've worked for ${duration} which covers your pending time.\nYour extra work session has been automatically completed.\n\nGreat job staying committed! 💪✨`
                    });

                    console.log(`✅ Auto-completed extra work for user ${userId} - worked ${duration}`);
                    return;
                } catch (error) {
                    console.error('Error auto-completing extra work:', error);
                }
            }

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
// ADMIN HELPER FUNCTIONS
// ================================

async function getLiveAdminStatus() {
    try {
        // Get all active leave sessions
        const activeLeave = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT ls.*, u.name as user_name FROM leave_sessions ls
                JOIN users u ON ls.user_id = u.id
                WHERE ls.end_time IS NULL 
                ORDER BY ls.start_time DESC`,
                (err, sessions) => {
                    if (err) reject(err);
                    else resolve(sessions || []);
                }
            );
        });

        // Get all active extra work sessions
        const activeExtraWork = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT ews.*, u.name as user_name FROM extra_work_sessions ews
                JOIN users u ON ews.user_id = u.id
                WHERE ews.end_time IS NULL 
                ORDER BY ews.start_time DESC`,
                (err, sessions) => {
                    if (err) reject(err);
                    else resolve(sessions || []);
                }
            );
        });

        // Get users with pending work
        const pendingWork = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT ds.*, u.name as user_name FROM daily_summaries ds
                JOIN users u ON ds.user_id = u.id
                WHERE ds.pending_extra_work_minutes > 0 
                ORDER BY ds.date DESC, ds.pending_extra_work_minutes DESC`,
                (err, sessions) => {
                    if (err) reject(err);
                    else resolve(sessions || []);
                }
            );
        });

        // Get recent activity (last 24 hours)
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        const recentActivity = await db.getAdminReport(yesterdayStr, Utils.getCurrentDate());

        return {
            activeLeave,
            activeExtraWork,
            pendingWork,
            recentActivity
        };
    } catch (error) {
        console.error('Error getting live admin status:', error);
        return {
            activeLeave: [],
            activeExtraWork: [],
            pendingWork: [],
            recentActivity: []
        };
    }
}

// ================================
// BUTTON INTERACTIONS
// ================================

// Admin Dashboard Actions - Interactive Modals
app.action('admin_live_status', async ({ body, ack, client }) => {
    await ack();
    try {
        const liveStatus = await getLiveAdminStatus();
        const modal = Utils.createLiveStatusModal(liveStatus);
        
        await client.views.open({
            trigger_id: body.trigger_id,
            view: modal
        });
    } catch (error) {
        console.error('Error in admin live status:', error);
    }
});

app.action('admin_reports', async ({ body, ack, client }) => {
    await ack();
    try {
        const modal = Utils.createReportsModal();
        
        await client.views.open({
            trigger_id: body.trigger_id,
            view: modal
        });
    } catch (error) {
        console.error('Error in admin reports:', error);
    }
});

app.action('admin_users', async ({ body, ack, respond }) => {
    await ack();
    try {
        const users = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT u.*, 
                COUNT(DISTINCT ls.id) as total_sessions,
                COALESCE(SUM(ds.pending_extra_work_minutes), 0) as total_pending
                FROM users u
                LEFT JOIN leave_sessions ls ON u.id = ls.user_id
                LEFT JOIN daily_summaries ds ON u.id = ds.user_id
                GROUP BY u.id
                ORDER BY total_pending DESC, total_sessions DESC`,
                (err, results) => {
                    if (err) reject(err);
                    else resolve(results || []);
                }
            );
        });
        
        const usersMessage = Utils.formatUsersManagement(users);
        await respond({
            text: usersMessage.text,
            blocks: usersMessage.blocks,
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error in admin users:', error);
        await respond({ text: "Error loading users.", response_type: 'ephemeral' });
    }
});

app.action('admin_analytics', async ({ body, ack, client }) => {
    await ack();
    try {
        const analytics = await getAnalyticsData();
        const modal = Utils.createAnalyticsModal(analytics);
        
        await client.views.open({
            trigger_id: body.trigger_id,
            view: modal
        });
    } catch (error) {
        console.error('Error in admin analytics:', error);
    }
});

app.action('admin_actions', async ({ body, ack, respond }) => {
    await ack();
    try {
        await respond({
            text: "⚡ Admin Actions",
            blocks: Utils.getAdminActionsMenu(),
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error in admin actions:', error);
        await respond({ text: "Error loading actions menu.", response_type: 'ephemeral' });
    }
});

// Report Actions
app.action('report_weekly', async ({ body, ack, respond }) => {
    await ack();
    try {
        const endDate = Utils.getCurrentDate();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        const startDateStr = startDate.toISOString().split('T')[0];
        
        const reportData = await db.getAdminReport(startDateStr, endDate);
        const report = Utils.formatAdminReport(reportData, startDateStr, endDate);
        
        await respond({
            text: report,
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error in weekly report:', error);
        await respond({ text: "Error generating weekly report.", response_type: 'ephemeral' });
    }
});

app.action('report_monthly', async ({ body, ack, respond }) => {
    await ack();
    try {
        const endDate = Utils.getCurrentDate();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        const startDateStr = startDate.toISOString().split('T')[0];
        
        const reportData = await db.getAdminReport(startDateStr, endDate);
        const report = Utils.formatAdminReport(reportData, startDateStr, endDate);
        
        await respond({
            text: report,
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error in monthly report:', error);
        await respond({ text: "Error generating monthly report.", response_type: 'ephemeral' });
    }
});

// Admin Action Handlers
app.action('action_send_reminders', async ({ body, ack, respond }) => {
    await ack();
    try {
        const pendingUsers = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT DISTINCT ds.user_id, u.name, SUM(ds.pending_extra_work_minutes) as total_pending
                FROM daily_summaries ds
                JOIN users u ON ds.user_id = u.id
                WHERE ds.pending_extra_work_minutes > 0
                GROUP BY ds.user_id
                ORDER BY total_pending DESC`,
                (err, results) => {
                    if (err) reject(err);
                    else resolve(results || []);
                }
            );
        });

        let sentCount = 0;
        for (const user of pendingUsers) {
            try {
                const pendingTime = Utils.formatDuration(user.total_pending);
                await app.client.chat.postMessage({
                    channel: user.user_id,
                    text: `👋 *Friendly Reminder*\n\nHi ${user.name}! You have ${pendingTime} of pending extra work.\n\n🔄 Use \`/work-start\` when you're ready to complete it.\n\nThanks for staying on top of things! 🙏`
                });
                sentCount++;
            } catch (error) {
                console.error(`Error sending reminder to ${user.name}:`, error);
            }
        }

        await respond({
            text: `✅ Sent reminders to ${sentCount} user(s) with pending work.`,
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error sending reminders:', error);
        await respond({ text: "Error sending reminders.", response_type: 'ephemeral' });
    }
});

app.action('action_reset_pending', async ({ body, ack, respond }) => {
    await ack();
    try {
        await respond({
            text: "🔄 *Reset Pending Work*\n\nSelect users to reset their pending work:",
            blocks: await getUserResetMenu(),
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error loading reset menu:', error);
        await respond({ text: "Error loading reset menu.", response_type: 'ephemeral' });
    }
});

app.action('action_approve_time', async ({ body, ack, respond }) => {
    await ack();
    try {
        await respond({
            text: "✅ *Approve Exceeded Time*\n\nSelect sessions to approve:",
            blocks: await getApprovalMenu(),
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error loading approval menu:', error);
        await respond({ text: "Error loading approval menu.", response_type: 'ephemeral' });
    }
});

// Reset user pending work
app.action(/^reset_user_(.+)$/, async ({ body, ack, respond, action }) => {
    await ack();
    try {
        const userId = action.action_id.replace('reset_user_', '');
        
        // Reset all pending work for this user
        await new Promise((resolve, reject) => {
            db.db.run(
                `UPDATE daily_summaries 
                SET pending_extra_work_minutes = 0,
                    updated_at = ?
                WHERE user_id = ? AND pending_extra_work_minutes > 0`,
                [new Date().toISOString(), userId],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });

        const userInfo = await app.client.users.info({ user: userId });
        const userName = userInfo.user.real_name || userInfo.user.name;

        await respond({
            text: `✅ Reset pending work for *${userName}*`,
            replace_original: false,
            response_type: 'ephemeral'
        });

        // Notify the user
        await app.client.chat.postMessage({
            channel: userId,
            text: `✅ *Good News!*\n\nYour pending extra work has been cleared by an admin.\nThanks for your efforts! 🎉`
        });

    } catch (error) {
        console.error('Error resetting pending work:', error);
        await respond({ text: "Error resetting pending work.", response_type: 'ephemeral' });
    }
});

async function getUserResetMenu() {
    const pendingUsers = await new Promise((resolve, reject) => {
        db.db.all(
            `SELECT DISTINCT ds.user_id, u.name, SUM(ds.pending_extra_work_minutes) as total_pending
            FROM daily_summaries ds
            JOIN users u ON ds.user_id = u.id
            WHERE ds.pending_extra_work_minutes > 0
            GROUP BY ds.user_id
            ORDER BY total_pending DESC
            LIMIT 10`,
            (err, results) => {
                if (err) reject(err);
                else resolve(results || []);
            }
        );
    });

    if (pendingUsers.length === 0) {
        return [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "✅ No users with pending work found."
                }
            }
        ];
    }

    const userButtons = pendingUsers.map(user => ({
        type: "button",
        text: { 
            type: "plain_text", 
            text: `🔄 ${user.name} (${Utils.formatDuration(user.total_pending)})` 
        },
        action_id: `reset_user_${user.user_id}`,
        style: "danger"
    }));

    // Split into groups of 5 (Slack limit)
    const buttonGroups = [];
    for (let i = 0; i < userButtons.length; i += 5) {
        buttonGroups.push({
            type: "actions",
            elements: userButtons.slice(i, i + 5)
        });
    }

    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: "Select a user to reset their pending work:"
            }
        },
        ...buttonGroups
    ];
}

async function getApprovalMenu() {
    // Get recent exceeded sessions
    const exceededSessions = await new Promise((resolve, reject) => {
        db.db.all(
            `SELECT ls.*, u.name as user_name 
            FROM leave_sessions ls
            JOIN users u ON ls.user_id = u.id
            WHERE ls.actual_duration > ls.planned_duration
            AND ls.end_time IS NOT NULL
            AND DATE(ls.start_time) >= DATE('now', '-7 days')
            ORDER BY ls.start_time DESC
            LIMIT 10`,
            (err, results) => {
                if (err) reject(err);
                else resolve(results || []);
            }
        );
    });

    if (exceededSessions.length === 0) {
        return [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "✅ No recent exceeded sessions found."
                }
            }
        ];
    }

    let text = "Recent sessions that exceeded planned time:\n\n";
    exceededSessions.forEach((session, index) => {
        const date = Utils.formatDate(session.date);
        const planned = Utils.formatDuration(session.planned_duration);
        const actual = Utils.formatDuration(session.actual_duration);
        const exceeded = Utils.formatDuration(session.actual_duration - session.planned_duration);
        
        text += `${index + 1}. *${session.user_name}* (${date})\n`;
        text += `   Planned: ${planned}, Actual: ${actual}, Exceeded: ${exceeded}\n`;
        text += `   Reason: ${session.reason}\n\n`;
    });

    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text
            }
        }
    ];
}

// Handle unplanned leave modal submission
app.view('unplanned_leave_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const user_id = body.user.id;
        
        // Extract values from the modal
        const values = view.state.values;
        
        // Get hours and minutes from the selects
        const hours = parseInt(values.leave_hours?.hours_select?.selected_option?.value || '0');
        const minutes = parseInt(values.leave_minutes?.minutes_select?.selected_option?.value || '0');
        
        // Get reason (optional)
        const reason = values.leave_reason?.reason_input?.value?.trim() || 'Unplanned leave';
        
        // Calculate total duration in minutes
        const durationMinutes = (hours * 60) + minutes;
        
        // Validate duration
        if (durationMinutes === 0) {
            // Show error - can't have 0 duration
            return {
                response_action: 'errors',
                errors: {
                    leave_hours: 'Please select at least 15 minutes',
                    leave_minutes: 'Please select at least 15 minutes'
                }
            };
        }
        
        if (durationMinutes > 480) { // 8 hours max
            return {
                response_action: 'errors',
                errors: {
                    leave_hours: 'Maximum 8 hours allowed'
                }
            };
        }
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;
        
        // Create user in database if not exists
        await db.createUser(user_id, userName, userInfo.user.profile?.email);
        
        // Calculate return time
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
        
        // Send success message to user (private)
        await client.chat.postEphemeral({
            channel: config.bot.transparencyChannel,
            user: user_id,
            text: `✅ *Leave started successfully!*\n\n⏰ Duration: ${formattedDuration}\n🕐 Expected return: ${returnTime}\n📝 Reason: ${reason}\n\nPosted to ${config.bot.transparencyChannel} for transparency. 👍`
        });
        
        // Notify configured users/channels
        for (const user of config.notifications.notifyUsers) {
            try {
                await client.chat.postMessage({
                    channel: user,
                    text: `📋 *Leave Notification*\n${message}`
                });
            } catch (error) {
                console.error(`Failed to notify ${user}:`, error);
            }
        }
        
    } catch (error) {
        console.error('Error processing leave modal:', error);
        
        // Send error message to user
        await client.chat.postEphemeral({
            channel: config.bot.transparencyChannel,
            user: body.user.id,
            text: "❌ Sorry, there was an error starting your leave session. Please try again."
        });
    }
});

// User drill-down actions
app.action(/^user_details_(.+)$/, async ({ body, ack, respond, action }) => {
    await ack();
    try {
        const userId = action.action_id.replace('user_details_', '');
        const userDetails = await getUserDetailedInfo(userId);
        const detailsMessage = Utils.formatUserDetails(userDetails);
        
        await respond({
            text: detailsMessage.text,
            blocks: detailsMessage.blocks,
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error getting user details:', error);
        await respond({ text: "Error loading user details.", response_type: 'ephemeral' });
    }
});

async function getAnalyticsData() {
    // Get data for the last 30 days
    const endDate = Utils.getCurrentDate();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    const startDateStr = startDate.toISOString().split('T')[0];

    const analytics = await new Promise((resolve, reject) => {
        db.db.all(
            `SELECT 
                DATE(ls.start_time) as date,
                COUNT(*) as daily_sessions,
                AVG(ls.actual_duration) as avg_duration,
                MAX(ls.actual_duration) as max_duration,
                COUNT(CASE WHEN ls.actual_duration > ls.planned_duration THEN 1 END) as exceeded_sessions
            FROM leave_sessions ls
            WHERE ls.date BETWEEN ? AND ?
            AND ls.end_time IS NOT NULL
            GROUP BY DATE(ls.start_time)
            ORDER BY date DESC`,
            [startDateStr, endDate],
            (err, results) => {
                if (err) reject(err);
                else resolve(results || []);
            }
        );
    });

    return analytics;
}

async function getUserDetailedInfo(userId) {
    const userInfo = await new Promise((resolve, reject) => {
        db.db.get(
            `SELECT * FROM users WHERE id = ?`,
            [userId],
            (err, result) => {
                if (err) reject(err);
                else resolve(result);
            }
        );
    });

    const recentSessions = await new Promise((resolve, reject) => {
        db.db.all(
            `SELECT * FROM leave_sessions 
            WHERE user_id = ? 
            ORDER BY start_time DESC 
            LIMIT 10`,
            [userId],
            (err, results) => {
                if (err) reject(err);
                else resolve(results || []);
            }
        );
    });

    const summaries = await new Promise((resolve, reject) => {
        db.db.all(
            `SELECT * FROM daily_summaries 
            WHERE user_id = ? 
            ORDER BY date DESC 
            LIMIT 7`,
            [userId],
            (err, results) => {
                if (err) reject(err);
                else resolve(results || []);
            }
        );
    });

    return {
        user: userInfo,
        recentSessions,
        summaries
    };
}

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
// AUTOMATIC TIME EXCEEDED CHECKS
// ================================

// Check for exceeded leave times every 30 minutes
cron.schedule('*/30 * * * *', async () => {
    try {
        // Get all active leave sessions
        const activeSession = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT * FROM leave_sessions 
                WHERE end_time IS NULL 
                AND datetime('now') > datetime(start_time, '+' || planned_duration || ' minutes')`,
                (err, sessions) => {
                    if (err) reject(err);
                    else resolve(sessions);
                }
            );
        });

        for (const session of activeSession) {
            try {
                const userInfo = await app.client.users.info({ user: session.user_id });
                const userName = userInfo.user.real_name || userInfo.user.name;
                const plannedDuration = Utils.formatDuration(session.planned_duration);
                const currentDuration = Math.round((new Date() - new Date(session.start_time)) / (1000 * 60));
                const actualDuration = Utils.formatDuration(currentDuration);

                // Send DM notification about time exceeded
                await app.client.chat.postMessage({
                    channel: session.user_id,
                    text: `⏰ *Friendly Reminder* 🙂\n\nHi ${userName}! Your planned leave time of *${plannedDuration}* has been exceeded.\nYou've been away for *${actualDuration}* so far.\n\n✅ *When you're back:*\n1. Use \`/return\` in ${config.bot.transparencyChannel} to mark your return\n2. Use \`/work-start\` to begin extra work to compensate\n\nNo worries - we all lose track of time sometimes! 😊`
                });

                console.log(`⚠️ Sent time exceeded alert to ${userName}`);

                // Mark this session as notified (add a flag to prevent spam)
                db.db.run(
                    `UPDATE leave_sessions SET reason = reason || ' [NOTIFIED]' 
                    WHERE id = ? AND reason NOT LIKE '%[NOTIFIED]%'`,
                    [session.id]
                );

            } catch (error) {
                console.error(`Error sending time exceeded alert to user ${session.user_id}:`, error);
            }
        }

    } catch (error) {
        console.error('Error in time exceeded check:', error);
    }
});

// ================================
// SCHEDULED TASKS
// ================================

// End of day summary (6 PM IST weekdays)
cron.schedule('30 12 * * 1-5', async () => {
    try {
        console.log('Running end-of-day summary...');
        
        const today = Utils.getCurrentDate();
        const usersWithPendingWork = await db.getAllUsersWithPendingWork(0); // Get users with pending work today
        
        if (usersWithPendingWork.length === 0) {
            console.log('✅ No users with pending work today - no notifications sent');
            return;
        }
        
        for (const user of usersWithPendingWork) {
            try {
                const summary = await db.getUserDailySummary(user.id, today);
                
                // Only notify users who have pending extra work
                if (summary && summary.pending_extra_work_minutes > 0) {
                    const userInfo = await app.client.users.info({ user: user.id });
                    const userName = userInfo.user.real_name || userInfo.user.name;
                    
                    const summaryMessage = Utils.formatUserDailySummary(summary, userName);
                    
                    // Send DM with @mention for notification
                    await app.client.chat.postMessage({
                        channel: user.id,
                        text: `🌅 *End of Day Summary*\n\n<@${user.id}> ${summaryMessage}`
                    });
                    
                    console.log(`📬 Sent end-of-day notification to ${userName}`);
                }
            } catch (error) {
                console.error(`Error sending summary to user ${user.id}:`, error);
            }
        }
        
    } catch (error) {
        console.error('Error in end-of-day summary:', error);
    }
});

// Weekly reminder for pending extra work (Monday 9 AM IST)
cron.schedule('30 3 * * 1', async () => {
    try {
        console.log('Running weekly reminder...');
        
        const usersWithPendingWork = await db.getAllUsersWithPendingWork(7);
        
        for (const user of usersWithPendingWork) {
            try {
                const pendingTime = Utils.formatDuration(user.pending_extra_work_minutes);
                const daysAgo = Utils.getWorkingDaysBetween(user.date, Utils.getCurrentDate());
                
                await app.client.chat.postMessage({
                    channel: user.id,
                    text: `⚠️ *Weekly Reminder*\n\nYou have ${pendingTime} of pending extra work from ${daysAgo} day(s) ago.\nPlease use \`/work-start\` to log your extra work time.`
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
        console.log(`  • Keepalive: ${RENDER_URL ? '✅ Enabled' : '❌ Disabled (add RENDER_URL env var)'}`);
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