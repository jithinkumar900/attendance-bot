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
        maxIntermediateHours: parseFloat(process.env.MAX_INTERMEDIATE_HOURS) || 2.5,
        workingHoursPerDay: parseFloat(process.env.WORKING_HOURS_PER_DAY) || 8,
        extraWorkDeadlineDays: parseInt(process.env.EXTRA_WORK_DEADLINE_DAYS) || 7,
        adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
        transparencyChannel: process.env.TRANSPARENCY_CHANNEL || '#intermediate-logout',
        leaveApprovalChannel: process.env.LEAVE_APPROVAL_CHANNEL || '#leave-approval',
        hrTag: process.env.HR_TAG || 'U1234567890',
        leaveApprovalTag: process.env.LEAVE_APPROVAL_TAG || 'U0987654321'
    },
    notifications: {
        // Optional notification channel - only used for important admin notifications
        notifyChannel: process.env.NOTIFY_CHANNEL || null, // Set to null to disable
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

// Self-ping every 5 minutes to prevent spin-down (more frequent for better reliability)
const RENDER_URL = process.env.RENDER_URL; // We'll add this as env var

if (RENDER_URL) {
    // Main keepalive - every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        try {
            await axios.get(`${RENDER_URL}/ping`, { timeout: 5000 });
            console.log('🔄 Keepalive ping successful');
        } catch (error) {
            console.log('⚠️ Keepalive ping failed (normal if service is spinning up)');
        }
    });
    
    // Additional lightweight ping every 2 minutes during business hours (9 AM - 6 PM IST)
    cron.schedule('*/2 9-18 * * 1-5', async () => {
        try {
            await axios.get(`${RENDER_URL}/health`, { timeout: 3000 });
            console.log('🔄 Business hours ping successful');
        } catch (error) {
            console.log('⚠️ Business hours ping failed');
        }
    });
}

// Track Socket Mode connection status
let socketConnected = false;
let lastActivityTime = new Date();

// Monitor Socket Mode connection (simplified approach)
// Note: Slack Bolt doesn't expose these events directly, so we'll track via activity
let connectionWarmed = false;

// Update activity timestamp on any interaction
function updateActivity() {
    lastActivityTime = new Date();
}

// Warmup function to ensure service is ready
async function warmupService() {
    try {
        if (RENDER_URL) {
            await axios.get(`${RENDER_URL}/ping`, { timeout: 3000 });
        }
        // Give Socket Mode a moment to ensure connection on first warmup
        if (!connectionWarmed) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            connectionWarmed = true;
        }
    } catch (error) {
        console.log('⚠️ Warmup ping failed (service may be cold starting)');
    }
}

// Proactive connection health monitor - check every minute for long idle periods
cron.schedule('* * * * *', () => {
    const idleMinutes = Math.floor((new Date() - lastActivityTime) / (1000 * 60));
    
    // If idle for more than 30 minutes and during business hours, do a light warmup
    if (idleMinutes > 30 && idleMinutes < 60) {
        const currentHour = new Date().getHours();
        if (currentHour >= 9 && currentHour <= 18) { // Business hours IST (adjusted for timezone)
            warmupService().catch(() => {}); // Silent warmup
        }
    }
});

// Auto-complete extra work sessions when enough time has been worked
cron.schedule('* * * * *', async () => {
    try {
        // Get all active extra work sessions
        const activeSessions = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT ews.*, u.name as user_name FROM extra_work_sessions ews
                JOIN users u ON ews.user_id = u.id
                WHERE ews.end_time IS NULL`,
                (err, sessions) => {
                    if (err) reject(err);
                    else resolve(sessions || []);
                }
            );
        });

        // Check each active session for auto-completion
        for (const session of activeSessions) {
            const currentDuration = Math.round((new Date() - new Date(session.start_time)) / (1000 * 60));
            const today = Utils.getCurrentDate();
            const summary = await db.getUserDailySummary(session.user_id, today);
            
            // Notify user that they can complete their session (require description)
            if (summary && currentDuration >= summary.pending_extra_work_minutes) {
                try {
                    const duration = Utils.formatDuration(currentDuration);

                    // Send message asking for work description to complete session
                    await app.client.chat.postMessage({
                        channel: session.user_id,
                        text: `🎉 *Extra Work Time Completed!*\n\nAwesome! You've worked for ${duration} which covers your pending time.\n\n📝 *To complete your session:*\nPlease use \`/work-end\` to describe what you worked on and officially end your session.\n\nGreat job staying committed! 💪✨`,
                        blocks: [
                            {
                                type: 'section',
                                text: {
                                    type: 'mrkdwn',
                                    text: `🎉 *Extra Work Time Completed!*\n\nAwesome! You've worked for *${duration}* which covers your pending time.\n\n📝 *To complete your session:*\nPlease use \`/work-end\` to describe what you worked on and officially end your session.\n\nGreat job staying committed! 💪✨`
                                }
                            },
                            {
                                type: 'actions',
                                elements: [
                                    {
                                        type: 'button',
                                        text: {
                                            type: 'plain_text',
                                            text: 'Complete Session'
                                        },
                                        style: 'primary',
                                        action_id: 'complete_extra_work',
                                        value: session.user_id
                                    }
                                ]
                            }
                        ]
                    });

                    console.log(`⏰ Notified user ${session.user_id} to complete their extra work session - worked ${duration}`);
                } catch (error) {
                    console.error('Error notifying user to complete extra work:', error);
                }
            }
        }
    } catch (error) {
        console.error('Error checking for auto-completion:', error);
    }
});

// ================================
// SLASH COMMANDS
// ================================

// Start intermediate logout - Interactive Modal
app.command('/intermediate_logout', async ({ command, ack, client }) => {
    await ack();
    
    // Update activity and ensure service is warmed up
    updateActivity();
    await warmupService();
    
    try {
        const { user_id, trigger_id } = command;

        // Check if user already has an active leave session
        const activeSession = await db.getUserActiveLeaveSession(user_id);
        if (activeSession) {
            // Calculate current duration and remaining time
            const currentDuration = Math.round((new Date() - new Date(activeSession.start_time)) / (1000 * 60));
            const plannedDuration = activeSession.planned_duration;
            const remainingTime = Math.max(0, plannedDuration - currentDuration);
            
            await client.views.open({
                trigger_id,
                view: {
                    type: 'modal',
                    callback_id: 'extend_leave_modal',
                    title: { type: 'plain_text', text: '⚠️ Already on Leave' },
                    submit: { type: 'plain_text', text: 'Extend Leave' },
                    close: { type: 'plain_text', text: 'Cancel' },
                    private_metadata: JSON.stringify({ sessionId: activeSession.id, currentDuration, plannedDuration, channelId: command.channel_id }),
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `🚨 *You are already on leave!*\n\nYour current leave session:\n• *Reason:* ${activeSession.reason}\n• *Planned Duration:* ${Utils.formatDuration(plannedDuration)}\n• *Time Elapsed:* ${Utils.formatDuration(currentDuration)}\n• *Time Remaining:* ${Utils.formatDuration(remainingTime)}\n\n${currentDuration > plannedDuration ? '⚠️ *You have exceeded your planned time!*\n\n' : ''}Would you like to extend your leave duration?`
                            }
                        },
                        {
                            type: 'input',
                            block_id: 'extend_hours',
                            element: {
                                type: 'static_select',
                                placeholder: { type: 'plain_text', text: 'Select additional hours' },
                                action_id: 'hours_select',
                                options: [
                                    { text: { type: 'plain_text', text: '0 hours' }, value: '0' },
                                    { text: { type: 'plain_text', text: '1 hour' }, value: '1' },
                                    { text: { type: 'plain_text', text: '2 hours' }, value: '2' },
                                    { text: { type: 'plain_text', text: '3 hours' }, value: '3' },
                                    { text: { type: 'plain_text', text: '4 hours' }, value: '4' }
                                ],
                                initial_option: { text: { type: 'plain_text', text: '0 hours' }, value: '0' }
                            },
                            label: { type: 'plain_text', text: '🕐 Additional Hours' }
                        },
                        {
                            type: 'input',
                            block_id: 'extend_minutes',
                            element: {
                                type: 'static_select',
                                placeholder: { type: 'plain_text', text: 'Select additional minutes' },
                                action_id: 'minutes_select',
                                options: [
                                    { text: { type: 'plain_text', text: '0 minutes' }, value: '0' },
                                    { text: { type: 'plain_text', text: '15 minutes' }, value: '15' },
                                    { text: { type: 'plain_text', text: '30 minutes' }, value: '30' },
                                    { text: { type: 'plain_text', text: '45 minutes' }, value: '45' }
                                ],
                                initial_option: { text: { type: 'plain_text', text: '15 minutes' }, value: '15' }
                            },
                            label: { type: 'plain_text', text: '⏰ Additional Minutes' }
                        },
                        {
                            type: 'input',
                            block_id: 'extend_task_escalation',
                            element: {
                                type: 'plain_text_input',
                                action_id: 'escalation_input',
                                multiline: true,
                                placeholder: { type: 'plain_text', text: 'Describe the task you are working on and mention who you are assigning it to (e.g., "Working on API integration - escalating to @john.doe")' },
                                max_length: 500
                            },
                            label: { type: 'plain_text', text: '🔄 Task Escalation *' }
                        },
                        {
                            type: 'context',
                            elements: [
                                {
                                    type: 'mrkdwn',
                                    text: '💡 *Tip: Use `/return` to end your current session and start fresh*\n⚠️ *Task escalation is required to ensure proper handoff*'
                                }
                            ]
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
                callback_id: 'intermediate_logout_modal',
                title: { type: 'plain_text', text: 'Intermediate Logout' },
                submit: { type: 'plain_text', text: 'Start Leave' },
                close: { type: 'plain_text', text: 'Cancel' },
                private_metadata: command.channel_id,
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
                        type: 'input',
                        block_id: 'task_escalation',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'escalation_input',
                            multiline: true,
                            placeholder: { type: 'plain_text', text: 'Describe the task you are working on and mention who you are assigning it to (e.g., "Working on API integration - escalating to @john.doe")' },
                            max_length: 500
                        },
                        label: { type: 'plain_text', text: '🔄 Task Escalation *' }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '💡 *This will be posted to your configured transparency channel for transparency*\n⚠️ *Task escalation is required to ensure proper handoff*'
                            }
                        ]
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Error in intermediate logout modal:', error);
        
        // Provide helpful error message based on the type of error
        let errorMessage = "Sorry, there was an error opening the leave form.";
        
        if (error.message && error.message.includes('timeout')) {
            errorMessage += " The service may be warming up. Please wait 10 seconds and try again.";
        } else if (!connectionWarmed) {
            errorMessage += " Connection is being established. Please try again in a moment.";
        } else {
            errorMessage += " Please try again.";
        }
        
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: errorMessage
        });
    }
});

// Start planned leave - Interactive Modal
app.command('/planned', async ({ command, ack, client }) => {
    await ack();
    
    // Update activity and ensure service is warmed up
    updateActivity();
    await warmupService();
    
    try {
        const { user_id, trigger_id } = command;

        // Open interactive modal for planned leave
        await client.views.open({
            trigger_id,
            view: {
                type: 'modal',
                callback_id: 'planned_leave_modal',
                title: { type: 'plain_text', text: 'Request Planned Leave' },
                submit: { type: 'plain_text', text: 'Submit Request' },
                close: { type: 'plain_text', text: 'Cancel' },
                private_metadata: command.channel_id,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '📅 *Plan your leave in advance*\n\nFill out the details below to request planned leave:'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'leave_type',
                        element: {
                            type: 'static_select',
                            placeholder: { type: 'plain_text', text: 'Select leave type' },
                            action_id: 'type_select',
                            options: [
                                { text: { type: 'plain_text', text: 'Full Day' }, value: 'full_day' },
                                { text: { type: 'plain_text', text: 'Half Day (Morning)' }, value: 'half_day_morning' },
                                { text: { type: 'plain_text', text: 'Half Day (Afternoon)' }, value: 'half_day_afternoon' },
                                { text: { type: 'plain_text', text: 'Custom Hours' }, value: 'custom_hours' }
                            ],
                            initial_option: { text: { type: 'plain_text', text: 'Full Day' }, value: 'full_day' }
                        },
                        label: { type: 'plain_text', text: '📋 Leave Type' }
                    },
                    {
                        type: 'input',
                        block_id: 'start_date',
                        element: {
                            type: 'datepicker',
                            action_id: 'start_date_select',
                            placeholder: { type: 'plain_text', text: 'Select start date' },
                            initial_date: Utils.getTomorrowDate()
                        },
                        label: { type: 'plain_text', text: '📅 Start Date' }
                    },
                    {
                        type: 'input',
                        block_id: 'end_date',
                        element: {
                            type: 'datepicker',
                            action_id: 'end_date_select',
                            placeholder: { type: 'plain_text', text: 'Select end date' },
                            initial_date: Utils.getTomorrowDate()
                        },
                        label: { type: 'plain_text', text: '📅 End Date' }
                    },
                    {
                        type: 'input',
                        block_id: 'leave_reason',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'reason_input',
                            placeholder: { type: 'plain_text', text: 'e.g., Vacation, Medical appointment, Personal matters' },
                            max_length: 200
                        },
                        label: { type: 'plain_text', text: '📝 Reason' }
                    },
                    {
                        type: 'input',
                        block_id: 'task_escalation',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'escalation_input',
                            multiline: true,
                            placeholder: { type: 'plain_text', text: 'Describe tasks and who you are assigning them to (e.g., "Project X - @john.doe, Client meeting - @jane.smith")' },
                            max_length: 500
                        },
                        label: { type: 'plain_text', text: '🔄 Task Escalation *' }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '⚠️ *Task escalation is required to ensure proper handoff*'
                            }
                        ]
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Error in planned modal:', error);
        
        // Provide helpful error message based on the type of error
        let errorMessage = "Sorry, there was an error opening the planned leave form.";
        
        if (error.message && error.message.includes('timeout')) {
            errorMessage += " The service may be warming up. Please wait 10 seconds and try again.";
        } else if (!connectionWarmed) {
            errorMessage += " Connection is being established. Please try again in a moment.";
        } else {
            errorMessage += " Please try again.";
        }
        
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: errorMessage
        });
    }
});

// End intermediate logout
app.command('/return', async ({ command, ack, say, client }) => {
    await ack();
    updateActivity();
    
    try {
        const { user_id } = command;

        // End the leave session
        const session = await db.endLeaveSession(user_id);
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        const actualDuration = Utils.formatDuration(session.actualDuration);
        const plannedDuration = Utils.formatDuration(session.planned_duration);

        // Send transparency message
        const message = Utils.formatLeaveEndMessage(userName, actualDuration);
        
        await client.chat.postMessage({
            channel: config.bot.transparencyChannel,
            text: message
        });

        // Update daily summary
        const today = Utils.getCurrentDate();
        const summary = await db.updateDailySummary(user_id, today);

        // Check if total leave exceeds threshold (now considered regular leave, not intermediate logout)
        if (Utils.exceedsThreshold(summary.totalLeave, config.bot.maxIntermediateHours)) {
            const totalLeaveFormatted = Utils.formatDuration(summary.totalLeave);
            const timeExceededMessage = Utils.formatTimeExceededMessage(totalLeaveFormatted);
            
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: user_id,
                text: timeExceededMessage
            });
            
            // Inform HR about conversion to half-day leave  
            await client.chat.postMessage({
                channel: config.bot.leaveApprovalChannel,
                text: `ℹ️ *Half Day Leave Processed*\n\n👤 *Employee:* ${userName}\n⏰ *Total time today:* ${totalLeaveFormatted}\n📝 *Status:* Processed as half-day leave (exceeded ${config.bot.maxIntermediateHours}h intermediate logout limit)\n\n📋 <@${config.bot.hrTag}> - FYI: This has been automatically processed as half-day leave.`
            });
        } else {
            // Only suggest extra work if leave doesn't exceed half-day threshold
            if (session.actualDuration > session.planned_duration) {
                const exceededBy = Utils.formatDuration(session.actualDuration - session.planned_duration);
                
                // Send polite DM about extra time taken
                await client.chat.postMessage({
                    channel: user_id,
                    text: `😊 *Time Summary*\n\nHi! You planned to be away for *${plannedDuration}* but were actually away for *${actualDuration}*.\nExtra time taken: *${exceededBy}*\n\n🔄 *Next Steps:*\n1. When convenient, use \`/work-start\` to begin ${exceededBy} of extra work\n2. I'll help track your progress!\n\nThanks for being transparent! 🙏`
                });
            }
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
    updateActivity();
    
    try {
        const { user_id, text = 'Compensating intermediate logout' } = command;

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
            text: `⏰ *${userName}* started extra work session to compensate for intermediate logout.`
        });

        // Send private confirmation to user
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: user_id,
            text: `⏰ *Extra work session started!*\n\nWork as needed - I'll auto-complete when you've worked enough time to cover your leave. Use \`/work-end\` anytime to finish manually. Good luck! 💪`
        });

        // Note: Auto-completion will happen via the minute-by-minute check system
        // No need for hourly prompts - just let them work in peace

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
    updateActivity();
    
    try {
        const { user_id } = command;

        // Check if user has an active extra work session
        const activeSession = await db.getUserActiveExtraWorkSession(user_id);
        if (!activeSession) {
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: user_id,
                text: "You don't have an active extra work session to end."
            });
            return;
        }

        // Show modal to collect work description
        await client.views.open({
            trigger_id: command.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'work_end_modal',
                title: { type: 'plain_text', text: 'End Extra Work Session' },
                submit: { type: 'plain_text', text: 'Complete Session' },
                close: { type: 'plain_text', text: 'Cancel' },
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '📝 *Please describe what you worked on during this session:*'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'work_description',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'description_input',
                            multiline: true,
                            placeholder: {
                                type: 'plain_text',
                                text: 'E.g., Fixed bug in user authentication, completed project documentation, attended team meeting, etc.'
                            },
                            max_length: 1000
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Work Description'
                        }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '💡 *This description will be saved for record-keeping and transparency*'
                            }
                        ]
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Error in work-end:', error);
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: "Sorry, there was an error ending your extra work session. Please try again."
        });
    }
});

// Check leave balance
app.command('/review', async ({ command, ack, say, client }) => {
    await ack();
    updateActivity();
    
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
            statusMessage += `• Pending: ${Utils.formatDuration(summary.pending_extra_work_minutes)}\n\n`;
        }

        // Add recent extra work sessions with descriptions
        const recentExtraWork = await db.getUserRecentExtraWorkSessions(user_id, 7);
        if (recentExtraWork.length > 0) {
            statusMessage += `💼 *Recent Extra Work (Last 7 Days)*\n`;
            recentExtraWork.forEach(session => {
                const date = Utils.formatDate(session.date);
                const duration = Utils.formatDuration(session.duration);
                statusMessage += `• ${date}: ${duration}`;
                if (session.work_description) {
                    statusMessage += ` - ${session.work_description}`;
                }
                statusMessage += `\n`;
            });
            statusMessage += `\n`;
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
    updateActivity();
    
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
app.action('report_weekly', async ({ body, ack, client }) => {
    console.log('🔥 WEEKLY REPORT BUTTON CLICKED! Body:', JSON.stringify(body, null, 2));
    await ack();
    try {
        console.log('📊 Weekly report requested');
        
        const endDate = Utils.getCurrentDate();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
        const startDateStr = startDate.toISOString().split('T')[0];
        
        console.log(`📅 Date range: ${startDateStr} to ${endDate}`);
        
        // Simplified query to avoid complex JOINs that might fail on Render
        const userData = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT 
                    u.id,
                    u.name,
                    COUNT(DISTINCT ls.id) as leave_count,
                    COALESCE(SUM(ls.actual_duration), 0) as total_leave,
                    COUNT(DISTINCT ews.id) as work_count,
                    COALESCE(SUM(ews.duration), 0) as total_work
                FROM users u
                LEFT JOIN leave_sessions ls ON u.id = ls.user_id 
                    AND ls.date BETWEEN ? AND ? AND ls.end_time IS NOT NULL
                LEFT JOIN extra_work_sessions ews ON u.id = ews.user_id 
                    AND ews.date BETWEEN ? AND ? AND ews.end_time IS NOT NULL
                GROUP BY u.id, u.name
                HAVING leave_count > 0 OR work_count > 0
                ORDER BY total_leave DESC`,
                [startDateStr, endDate, startDateStr, endDate],
                (err, results) => {
                    if (err) {
                        console.error('Weekly report query error:', err);
                        reject(err);
                    } else {
                        console.log(`📋 Found ${results.length} users with activity`);
                        resolve(results || []);
                    }
                }
            );
        });

        // Get extra work sessions with descriptions for this period
        const extraWorkWithDescriptions = await db.getExtraWorkSessionsWithDescriptions(startDateStr, endDate);
        
        // Create simple report text
        let reportText = `📊 *WEEKLY REPORT*\n📅 ${startDateStr} to ${endDate}\n\n`;
        
        if (userData.length === 0) {
            reportText += "✅ No activity this week!";
        } else {
            reportText += `👥 *Active Users: ${userData.length}*\n\n`;
            
            userData.forEach(user => {
                const leave = Utils.formatDuration(user.total_leave || 0);
                const work = Utils.formatDuration(user.total_work || 0);
                reportText += `• *${user.name}*\n`;
                reportText += `  Leave: ${leave} (${user.leave_count} sessions)\n`;
                reportText += `  Extra Work: ${work} (${user.work_count} sessions)\n\n`;
            });
        }

        // Add work descriptions section if any exist
        if (extraWorkWithDescriptions.length > 0) {
            reportText += `💼 *EXTRA WORK DETAILS:*\n\n`;
            extraWorkWithDescriptions.slice(0, 10).forEach(session => { // Limit to 10 to avoid long messages
                const date = Utils.formatDate(session.date);
                const duration = Utils.formatDuration(session.duration);
                reportText += `• *${session.user_name}* (${date}): ${duration}\n`;
                if (session.work_description) {
                    reportText += `  📝 ${session.work_description}\n`;
                }
                reportText += `\n`;
            });
            if (extraWorkWithDescriptions.length > 10) {
                reportText += `_... and ${extraWorkWithDescriptions.length - 10} more extra work sessions_\n`;
            }
        }
        
        console.log('📤 Sending weekly report response, length:', reportText.length);
        
        // Send as direct message since this is a modal interaction
        await client.chat.postMessage({
            channel: body.user.id,
            text: reportText
        });
        
        console.log('✅ Weekly report sent successfully');
        
    } catch (error) {
        console.error('❌ Error in weekly report:', error);
        console.error('Error stack:', error.stack);
        await client.chat.postMessage({
            channel: body.user.id,
            text: `❌ Error generating weekly report: ${error.message}`
        });
    }
});

app.action('report_monthly', async ({ body, ack, client }) => {
    console.log('🔥 MONTHLY REPORT BUTTON CLICKED! Body:', JSON.stringify(body, null, 2));
    await ack();
    try {
        console.log('📊 Monthly report requested');
        
        const endDate = Utils.getCurrentDate();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        const startDateStr = startDate.toISOString().split('T')[0];
        
        console.log(`📅 Date range: ${startDateStr} to ${endDate}`);
        
        // Simplified query to avoid complex JOINs that might fail on Render
        const userData = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT 
                    u.id,
                    u.name,
                    COUNT(DISTINCT ls.id) as leave_count,
                    COALESCE(SUM(ls.actual_duration), 0) as total_leave,
                    COUNT(DISTINCT ews.id) as work_count,
                    COALESCE(SUM(ews.duration), 0) as total_work
                FROM users u
                LEFT JOIN leave_sessions ls ON u.id = ls.user_id 
                    AND ls.date BETWEEN ? AND ? AND ls.end_time IS NOT NULL
                LEFT JOIN extra_work_sessions ews ON u.id = ews.user_id 
                    AND ews.date BETWEEN ? AND ? AND ews.end_time IS NOT NULL
                GROUP BY u.id, u.name
                HAVING leave_count > 0 OR work_count > 0
                ORDER BY total_leave DESC`,
                [startDateStr, endDate, startDateStr, endDate],
                (err, results) => {
                    if (err) {
                        console.error('Monthly report query error:', err);
                        reject(err);
                    } else {
                        console.log(`📋 Found ${results.length} users with activity`);
                        resolve(results || []);
                    }
                }
            );
        });

        // Get extra work sessions with descriptions for this period
        const extraWorkWithDescriptions = await db.getExtraWorkSessionsWithDescriptions(startDateStr, endDate);
        
        // Create simple report text
        let reportText = `📊 *MONTHLY REPORT*\n📅 ${startDateStr} to ${endDate}\n\n`;
        
        if (userData.length === 0) {
            reportText += "✅ No activity this month!";
        } else {
            reportText += `👥 *Active Users: ${userData.length}*\n\n`;
            
            // Calculate totals
            const totalLeave = userData.reduce((sum, u) => sum + (u.total_leave || 0), 0);
            const totalWork = userData.reduce((sum, u) => sum + (u.total_work || 0), 0);
            const totalSessions = userData.reduce((sum, u) => sum + (u.leave_count || 0), 0);
            
            reportText += `📈 *Summary:*\n`;
            reportText += `• Total Leave: ${Utils.formatDuration(totalLeave)} (${totalSessions} sessions)\n`;
            reportText += `• Total Extra Work: ${Utils.formatDuration(totalWork)}\n\n`;
            
            reportText += `👤 *Per User:*\n`;
            userData.forEach(user => {
                const leave = Utils.formatDuration(user.total_leave || 0);
                const work = Utils.formatDuration(user.total_work || 0);
                reportText += `• *${user.name}*: Leave ${leave}, Work ${work}\n`;
            });
        }

        // Add work descriptions section if any exist
        if (extraWorkWithDescriptions.length > 0) {
            reportText += `\n💼 *EXTRA WORK DETAILS:*\n\n`;
            extraWorkWithDescriptions.slice(0, 15).forEach(session => { // Limit to 15 for monthly report
                const date = Utils.formatDate(session.date);
                const duration = Utils.formatDuration(session.duration);
                reportText += `• *${session.user_name}* (${date}): ${duration}\n`;
                if (session.work_description) {
                    reportText += `  📝 ${session.work_description}\n`;
                }
                reportText += `\n`;
            });
            if (extraWorkWithDescriptions.length > 15) {
                reportText += `_... and ${extraWorkWithDescriptions.length - 15} more extra work sessions_\n`;
            }
        }
        
        console.log('📤 Sending monthly report response, length:', reportText.length);
        
        // Send as direct message since this is a modal interaction
        await client.chat.postMessage({
            channel: body.user.id,
            text: reportText
        });
        
        console.log('✅ Monthly report sent successfully');
        
    } catch (error) {
        console.error('❌ Error in monthly report:', error);
        console.error('Error stack:', error.stack);
        await client.chat.postMessage({
            channel: body.user.id,
            text: `❌ Error generating monthly report: ${error.message}`
        });
    }
});

// Admin Action Handlers
app.action('action_send_reminders', async ({ body, ack, respond }) => {
    await ack();
    try {
        await respond({
            text: "📢 *Send Reminders*\n\nSelect users to send reminders to:",
            blocks: await getReminderMenu(),
            replace_original: false,
            response_type: 'ephemeral'
        });
    } catch (error) {
        console.error('Error loading reminder menu:', error);
        await respond({ text: "Error loading reminder menu.", response_type: 'ephemeral' });
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

// Send reminder to specific user
app.action(/^remind_user_(.+)$/, async ({ body, ack, respond, action }) => {
    await ack();
    try {
        const userId = action.action_id.replace('remind_user_', '');
        
        // Get user's pending work
        const userPending = await new Promise((resolve, reject) => {
            db.db.get(
                `SELECT u.name, SUM(ds.pending_extra_work_minutes) as total_pending
                FROM daily_summaries ds
                JOIN users u ON ds.user_id = u.id
                WHERE ds.user_id = ? AND ds.pending_extra_work_minutes > 0
                GROUP BY ds.user_id`,
                [userId],
                (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                }
            );
        });

        if (!userPending) {
            await respond({
                text: `❌ User has no pending work to remind about.`,
                replace_original: false,
                response_type: 'ephemeral'
            });
            return;
        }

        const pendingTime = Utils.formatDuration(userPending.total_pending);
        
        // Send reminder to user
        await app.client.chat.postMessage({
            channel: userId,
            text: `👋 *Friendly Reminder*\n\nHi ${userPending.name}! You have ${pendingTime} of pending extra work.\n\n🔄 Use \`/work-start\` when you're ready to complete it.\n\nThanks for staying on top of things! 🙏`
        });

        await respond({
            text: `✅ Sent reminder to *${userPending.name}* (${pendingTime} pending)`,
            replace_original: false,
            response_type: 'ephemeral'
        });

    } catch (error) {
        console.error('Error sending reminder:', error);
        await respond({ text: "Error sending reminder.", response_type: 'ephemeral' });
    }
});

// Send reminders to all users with pending work
app.action('remind_all_users', async ({ body, ack, respond }) => {
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

        if (pendingUsers.length === 0) {
            await respond({
                text: "✅ No users with pending work found.",
                replace_original: false,
                response_type: 'ephemeral'
            });
            return;
        }

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
        console.error('Error sending reminders to all:', error);
        await respond({ text: "Error sending reminders to all users.", response_type: 'ephemeral' });
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

async function getReminderMenu() {
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
            text: `📢 ${user.name} (${Utils.formatDuration(user.total_pending)})` 
        },
        action_id: `remind_user_${user.user_id}`,
        style: "primary"
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
                text: "Select a user to send a reminder to:"
            }
        },
        ...buttonGroups,
        {
            type: "divider"
        },
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*📊 Found ${pendingUsers.length} user(s) with pending work*`
            },
            accessory: {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "📢 Send to All"
                },
                action_id: "remind_all_users",
                style: "danger"
            }
        }
    ];
}



// Handle intermediate logout modal submission
app.view('intermediate_logout_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const user_id = body.user.id;
        
        // Check if user already has an active leave session (safety check)
        const activeSession = await db.getUserActiveLeaveSession(user_id);
        if (activeSession) {
            await client.chat.postEphemeral({
                channel: config.bot.transparencyChannel,
                user: user_id,
                text: "❌ You already have an active leave session. Please use `/return` to end it first, or use the extend option."
            });
            return;
        }
        
        // Extract values from the modal
        const values = view.state.values;
        
        // Get hours and minutes from the selects
        const hours = parseInt(values.leave_hours?.hours_select?.selected_option?.value || '0');
        const minutes = parseInt(values.leave_minutes?.minutes_select?.selected_option?.value || '0');
        
        // Get reason (optional)
        const reason = values.leave_reason?.reason_input?.value?.trim() || 'Intermediate logout';
        
        // Get task escalation (required)
        const taskEscalation = values.task_escalation?.escalation_input?.value?.trim() || '';
        
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
        
        // Validate task escalation (required)
        if (!taskEscalation) {
            return {
                response_action: 'errors',
                errors: {
                    task_escalation: 'Task escalation is required. Please describe the task and who you are assigning it to.'
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
        
        // Create leave request for approval
        const requestId = await db.createLeaveRequest(
            user_id, 
            userName, 
            'intermediate', 
            reason, 
            taskEscalation, 
            {
                plannedDuration: durationMinutes,
                expectedReturnTime: returnTime
            }
        );
        
        // Send approval request to leave-approval channel with interactive buttons
        const approvalMessage = {
            text: `🔄 *Leave Request - Intermediate Logout*`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `🔄 *Leave Request - Intermediate Logout*\n\n👤 *Employee:* ${userName}\n⏰ *Duration:* ${formattedDuration}\n🕐 *Expected Return:* ${returnTime}\n📝 *Reason:* ${reason}\n\n🔄 *Task Escalation:*\n${taskEscalation}\n\n📋 <@${config.bot.leaveApprovalTag}> - Please review this leave request.`
                    }
                },
                {
                    type: 'actions',
                    elements: [
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: '✅ Approve' },
                            style: 'primary',
                            action_id: 'approve_leave',
                            value: requestId.toString()
                        },
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: '❌ Deny' },
                            style: 'danger',
                            action_id: 'deny_leave',
                            value: requestId.toString()
                        }
                    ]
                }
            ]
        };
        
        await client.chat.postMessage({
            channel: config.bot.leaveApprovalChannel,
            ...approvalMessage
        });
        
        // Send success message to user (private)
        let successMessage = `✅ *Leave request submitted successfully!*\n\n⏰ Duration: ${formattedDuration}\n🕐 Expected return: ${returnTime}\n📝 Reason: ${reason}`;
        
        if (taskEscalation) {
            successMessage += `\n🔄 Task Escalation: ${taskEscalation}`;
        }
        
        successMessage += `\n\n📋 Your request has been sent to ${config.bot.leaveApprovalChannel} for manager approval.`;
        
        // Send confirmation in the channel where user requested
        const channelId = body.view.private_metadata;
        await client.chat.postMessage({
            channel: channelId,
            text: `📋 *Leave Request Submitted*\n\n${userName} has submitted an intermediate logout request and is awaiting approval.`
        });
        
        await client.chat.postEphemeral({
            channel: channelId,
            user: user_id,
            text: successMessage
        });
        
        // Optional admin notification (only if channel is configured)
        // Note: This is minimal to maintain Socket Mode stability
        if (config.notifications.notifyChannel) {
            try {
                await client.chat.postMessage({
                    channel: config.notifications.notifyChannel,
                    text: `📋 Leave started: ${userName}`
                });
            } catch (error) {
                console.error(`Failed to notify admin channel:`, error);
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

// Handle extend leave modal submission
app.view('extend_leave_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const user_id = body.user.id;
        
        // Parse the private metadata
        const metadata = JSON.parse(view.private_metadata);
        const { sessionId, currentDuration, plannedDuration } = metadata;
        
        // Extract values from the modal
        const values = view.state.values;
        
        // Get additional hours and minutes
        const addHours = parseInt(values.extend_hours?.hours_select?.selected_option?.value || '0');
        const addMinutes = parseInt(values.extend_minutes?.minutes_select?.selected_option?.value || '0');
        
        // Get task escalation (required)
        const taskEscalation = values.extend_task_escalation?.escalation_input?.value?.trim() || '';
        
        // Calculate additional duration in minutes
        const additionalDuration = (addHours * 60) + addMinutes;
        
        // Validate extension
        if (additionalDuration === 0) {
            return {
                response_action: 'errors',
                errors: {
                    extend_minutes: 'Please select at least 15 minutes to extend'
                }
            };
        }
        
        // Validate task escalation (required)
        if (!taskEscalation) {
            return {
                response_action: 'errors',
                errors: {
                    extend_task_escalation: 'Task escalation is required. Please describe the task and who you are assigning it to.'
                }
            };
        }
        
        // Calculate new total planned duration
        const newPlannedDuration = plannedDuration + additionalDuration;
        
        if (newPlannedDuration > 480) { // 8 hours max total
            return {
                response_action: 'errors',
                errors: {
                    extend_hours: 'Total duration cannot exceed 8 hours'
                }
            };
        }
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;
        
        // Update the leave session in database
        await db.extendLeaveSession(sessionId, additionalDuration);
        
        // Calculate new return time
        const newReturnTime = Utils.calculateReturnTime(newPlannedDuration);
        const additionalTimeFormatted = Utils.formatDuration(additionalDuration);
        const newTotalFormatted = Utils.formatDuration(newPlannedDuration);
        
        // Send transparency message about extension
        let extensionMessage = `⏰ *${userName}* extended leave by *${additionalTimeFormatted}* (new total: *${newTotalFormatted}*, return by *${newReturnTime}*)`;
        
        if (taskEscalation) {
            extensionMessage += `\n\n🔄 *Task Escalation:* ${taskEscalation}`;
        }
        
        await client.chat.postMessage({
            channel: config.bot.transparencyChannel,
            text: extensionMessage
        });
        
        // Send success message to user (private)
        let extendSuccessMessage = `✅ *Leave extended successfully!*\n\n➕ Extended by: ${additionalTimeFormatted}\n⏱️ New total duration: ${newTotalFormatted}\n🕐 New expected return: ${newReturnTime}`;
        
        if (taskEscalation) {
            extendSuccessMessage += `\n🔄 Task Escalation: ${taskEscalation}`;
        }
        
        extendSuccessMessage += `\n\nUpdate posted to ${config.bot.transparencyChannel} for transparency. 👍`;
        
        await client.chat.postEphemeral({
            channel: config.bot.transparencyChannel,
            user: user_id,
            text: extendSuccessMessage
        });
        
    } catch (error) {
        console.error('Error processing extend leave modal:', error);
        
        // Send error message to user
        await client.chat.postEphemeral({
            channel: config.bot.transparencyChannel,
            user: body.user.id,
            text: "❌ Sorry, there was an error extending your leave session. Please try again."
        });
    }
});

// Handle planned leave modal submission
app.view('planned_leave_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const user_id = body.user.id;
        
        // Extract values from the modal
        const values = view.state.values;
        
        // Get form values
        const leaveType = values.leave_type?.type_select?.selected_option?.value || 'full_day';
        const startDate = values.start_date?.start_date_select?.selected_date;
        const endDate = values.end_date?.end_date_select?.selected_date;
        const reason = values.leave_reason?.reason_input?.value?.trim() || '';
        const taskEscalation = values.task_escalation?.escalation_input?.value?.trim() || '';
        
        // Validate required fields
        if (!startDate || !endDate) {
            return {
                response_action: 'errors',
                errors: {
                    start_date: !startDate ? 'Please select a start date' : '',
                    end_date: !endDate ? 'Please select an end date' : ''
                }
            };
        }
        
        if (!reason) {
            return {
                response_action: 'errors',
                errors: {
                    leave_reason: 'Please provide a reason for your leave'
                }
            };
        }
        
        if (!taskEscalation) {
            return {
                response_action: 'errors',
                errors: {
                    task_escalation: 'Task escalation is required. Please describe the tasks and who you are assigning them to.'
                }
            };
        }
        
        // Validate date range
        const start = new Date(startDate);
        const end = new Date(endDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (start < today) {
            return {
                response_action: 'errors',
                errors: {
                    start_date: 'Start date must be today or in the future'
                }
            };
        }
        
        if (end < start) {
            return {
                response_action: 'errors',
                errors: {
                    end_date: 'End date must be after or equal to start date'
                }
            };
        }
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;
        
        // Create user in database if not exists
        await db.createUser(user_id, userName, userInfo.user.profile?.email);
        
        // Format dates for display
        const formattedStartDate = Utils.formatDate(startDate);
        const formattedEndDate = Utils.formatDate(endDate);
        const dateRange = startDate === endDate ? formattedStartDate : `${formattedStartDate} - ${formattedEndDate}`;
        
        // Calculate duration in days
        const timeDiff = end.getTime() - start.getTime();
        const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1; // +1 to include both start and end dates
        
        // Create leave request for approval
        const requestId = await db.createLeaveRequest(
            user_id, 
            userName, 
            'planned', 
            reason, 
            taskEscalation, 
            {
                startDate: startDate,
                endDate: endDate,
                leaveDurationDays: daysDiff
            }
        );
        
        // Send approval request to leave-approval channel with interactive buttons
        const approvalMessage = {
            text: `📅 *Leave Request - Planned Leave*`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `📅 *Leave Request - Planned Leave*\n\n👤 *Employee:* ${userName}\n📅 *Dates:* ${dateRange}\n📋 *Type:* ${Utils.formatLeaveType(leaveType)}\n📝 *Reason:* ${reason}\n⏱️ *Duration:* ${daysDiff} day${daysDiff > 1 ? 's' : ''}\n\n🔄 *Task Escalation:*\n${taskEscalation}\n\n📋 <@${config.bot.leaveApprovalTag}> - Please review this leave request.`
                    }
                },
                {
                    type: 'actions',
                    elements: [
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: '✅ Approve' },
                            style: 'primary',
                            action_id: 'approve_leave',
                            value: requestId.toString()
                        },
                        {
                            type: 'button',
                            text: { type: 'plain_text', text: '❌ Deny' },
                            style: 'danger',
                            action_id: 'deny_leave',
                            value: requestId.toString()
                        }
                    ]
                }
            ]
        };
        
        await client.chat.postMessage({
            channel: config.bot.leaveApprovalChannel,
            ...approvalMessage
        });
        
        // Send success message to user (private)
        let successMessage = `✅ *Planned leave request submitted successfully!*\n\n`;
        successMessage += `📅 *Dates:* ${dateRange}\n`;
        successMessage += `📋 *Type:* ${Utils.formatLeaveType(leaveType)}\n`;
        successMessage += `📝 *Reason:* ${reason}\n`;
        successMessage += `🔄 *Task Escalation:* ${taskEscalation}`;
        successMessage += `\n\n📋 Your request has been sent to ${config.bot.leaveApprovalChannel} for manager approval.`;
        
        // Send confirmation in the channel where user requested
        const channelId = body.view.private_metadata;
        await client.chat.postMessage({
            channel: channelId,
            text: `📋 *Leave Request Submitted*\n\n${userName} has submitted a planned leave request and is awaiting approval.`
        });
        
        await client.chat.postEphemeral({
            channel: channelId,
            user: user_id,
            text: successMessage
        });
        
        // No form system - removed as per user request
        
        // Optional admin notification
        if (config.notifications.notifyChannel) {
            try {
                await client.chat.postMessage({
                    channel: config.notifications.notifyChannel,
                    text: `📋 Planned leave request: ${userName} (${dateRange})`
                });
            } catch (error) {
                console.error(`Failed to notify admin channel:`, error);
            }
        }
        
    } catch (error) {
        console.error('Error processing planned leave modal:', error);
        
        // Send error message to user
        await client.chat.postEphemeral({
            channel: config.bot.transparencyChannel,
            user: body.user.id,
            text: "❌ Sorry, there was an error submitting your planned leave request. Please try again."
        });
    }
});

// Handle work end modal submission
app.view('work_end_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const user_id = body.user.id;
        const values = view.state.values;
        
        // Extract work description
        const workDescription = values.work_description?.description_input?.value?.trim() || '';
        
        // Validate that description is provided
        if (!workDescription) {
            return {
                response_action: 'errors',
                errors: {
                    work_description: 'Work description is required to complete the session'
                }
            };
        }
        
        // End the extra work session with description
        const session = await db.endExtraWorkSession(user_id, workDescription);
        const duration = Utils.formatDuration(session.duration);

        // Get user info for public message
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;

        // Update daily summary
        const today = Utils.getCurrentDate();
        await db.updateDailySummary(user_id, today);

        // Post public message about extra work completion
        await client.chat.postMessage({
            channel: config.bot.transparencyChannel,
            text: `✅ *${userName}* completed extra work session\n\n⏱️ Duration: ${duration}\n📝 Work done: ${workDescription}`
        });

        // Send private confirmation to user
        await client.chat.postMessage({
            channel: user_id,
            text: `✅ *Extra work session completed!*\n\n⏱️ Duration: ${duration}\n📝 Work completed: ${workDescription}\n\nGreat job! 🎉`
        });

    } catch (error) {
        console.error('Error in work end modal:', error);
        
        if (error.message.includes('No active extra work session')) {
            await client.chat.postMessage({
                channel: body.user.id,
                text: "❌ No active extra work session found. You may have already ended it."
            });
        } else {
            await client.chat.postMessage({
                channel: body.user.id,
                text: "Sorry, there was an error ending your extra work session. Please try again."
            });
        }
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
app.action('extra_work_stop', async ({ body, ack, client }) => {
    await ack();
    
    try {
        const userId = body.actions[0].value;
        
        // Check if user still has an active session
        const activeSession = await db.getUserActiveExtraWorkSession(userId);
        if (!activeSession) {
            await client.chat.postMessage({
                channel: userId,
                text: "❌ No active extra work session found. You may have already ended it."
            });
            return;
        }

        // Show modal to collect work description
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'work_end_modal',
                title: { type: 'plain_text', text: 'End Extra Work Session' },
                submit: { type: 'plain_text', text: 'Complete Session' },
                close: { type: 'plain_text', text: 'Cancel' },
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '📝 *Please describe what you worked on during this session:*'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'work_description',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'description_input',
                            multiline: true,
                            placeholder: {
                                type: 'plain_text',
                                text: 'E.g., Fixed bug in user authentication, completed project documentation, attended team meeting, etc.'
                            },
                            max_length: 1000
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Work Description'
                        }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '💡 *This description will be saved for record-keeping and transparency*'
                            }
                        ]
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Error in extra work stop:', error);
        await client.chat.postMessage({
            channel: body.actions[0].value,
            text: "Sorry, there was an error ending your extra work session. Please try again."
        });
    }
});

// Handle complete extra work button
app.action('complete_extra_work', async ({ body, ack, client }) => {
    await ack();
    
    try {
        const userId = body.actions[0].value;
        
        // Check if user still has an active session
        const activeSession = await db.getUserActiveExtraWorkSession(userId);
        if (!activeSession) {
            await client.chat.postMessage({
                channel: userId,
                text: "❌ No active extra work session found. You may have already ended it."
            });
            return;
        }

        // Show modal to collect work description
        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'work_end_modal',
                title: { type: 'plain_text', text: 'Complete Extra Work' },
                submit: { type: 'plain_text', text: 'Complete Session' },
                close: { type: 'plain_text', text: 'Cancel' },
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '🎉 *Great job completing your extra work time!*\n\n📝 *Please describe what you worked on:*'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'work_description',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'description_input',
                            multiline: true,
                            placeholder: {
                                type: 'plain_text',
                                text: 'E.g., Fixed bug in user authentication, completed project documentation, attended team meeting, etc.'
                            },
                            max_length: 1000
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Work Description'
                        }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '💡 *This description will be saved for record-keeping and transparency*'
                            }
                        ]
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Error in complete extra work:', error);
        await client.chat.postMessage({
            channel: body.actions[0].value,
            text: "Sorry, there was an error completing your extra work session. Please try again."
        });
    }
});

// ================================
// LEAVE APPROVAL HANDLERS
// ================================

// Handle approve leave button
app.action('approve_leave', async ({ ack, body, client, action }) => {
    await ack();
    
    try {
        const requestId = parseInt(action.value);
        const approverId = body.user.id;
        
        // Anyone in the leave approval channel can approve requests
        // No additional authorization check needed
        
        // Get the leave request
        const leaveRequest = await db.getLeaveRequest(requestId);
        if (!leaveRequest) {
            await client.chat.postEphemeral({
                channel: body.channel.id,
                user: approverId,
                text: "❌ Leave request not found."
            });
            return;
        }
        
        if (leaveRequest.status !== 'pending') {
            await client.chat.postEphemeral({
                channel: body.channel.id,
                user: approverId,
                text: `❌ This leave request has already been ${leaveRequest.status}.`
            });
            return;
        }
        
        // Get approver info
        const approverInfo = await client.users.info({ user: approverId });
        const approverName = approverInfo.user.real_name || approverInfo.user.name;
        
        // Update leave request status
        await db.updateLeaveRequestStatus(requestId, 'approved', approverId);
        
        // For intermediate logout, start the actual leave session
        if (leaveRequest.leave_type === 'intermediate') {
            await db.startLeaveSession(leaveRequest.user_id, leaveRequest.planned_duration, leaveRequest.reason);
            
            // Send transparency message
            const returnTime = leaveRequest.expected_return_time;
            const formattedDuration = Utils.formatDuration(leaveRequest.planned_duration);
            const message = Utils.formatLeaveTransparencyMessage(
                leaveRequest.user_name, 
                formattedDuration, 
                leaveRequest.reason, 
                returnTime, 
                leaveRequest.task_escalation
            );
            
            await client.chat.postMessage({
                channel: config.bot.transparencyChannel,
                text: message
            });
            
            // Notify user
            await client.chat.postMessage({
                channel: leaveRequest.user_id,
                text: `✅ *Leave Approved!*\n\nYour intermediate logout request has been approved by ${approverName}.\n⏰ Duration: ${formattedDuration}\n🕐 Expected return: ${returnTime}\n\nYour leave has started automatically. Use \`/return\` when you're back!`
            });
        } else {
            // For planned leave, just notify user
            const dateRange = leaveRequest.start_date === leaveRequest.end_date ? 
                Utils.formatDate(leaveRequest.start_date) : 
                `${Utils.formatDate(leaveRequest.start_date)} - ${Utils.formatDate(leaveRequest.end_date)}`;
            
            await client.chat.postMessage({
                channel: leaveRequest.user_id,
                text: `✅ *Leave Approved!*\n\nYour planned leave request has been approved by ${approverName}.\n📅 Dates: ${dateRange}\n📝 Reason: ${leaveRequest.reason}`
            });
        }
        
        // Update the original message to show approval
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `✅ *Leave Request - ${leaveRequest.leave_type === 'intermediate' ? 'Intermediate Logout' : 'Planned Leave'}* (APPROVED)`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `✅ *Leave Request - ${leaveRequest.leave_type === 'intermediate' ? 'Intermediate Logout' : 'Planned Leave'}* (APPROVED)\n\n👤 *Employee:* ${leaveRequest.user_name}\n📝 *Reason:* ${leaveRequest.reason}\n\n✅ *Approved by:* ${approverName}\n⏰ *Approved at:* ${new Date().toLocaleString()}`
                    }
                }
            ]
        });
        
        // Send threaded reply for HR notification  
        await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message.ts,
            text: `✅ *Approval Notification*\n\n${approverName} has approved this leave request at ${new Date().toLocaleString()}\n\n📋 <@${config.bot.hrTag}> - Please take appropriate steps for this approval.`
        });
        
    } catch (error) {
        console.error('Error approving leave:', error);
        await client.chat.postEphemeral({
            channel: body.channel.id,
            user: body.user.id,
            text: "❌ Error approving leave request. Please try again."
        });
    }
});

// Handle deny leave button
app.action('deny_leave', async ({ ack, body, client, action }) => {
    await ack();
    
    try {
        const requestId = parseInt(action.value);
        const denierId = body.user.id;
        
        // Anyone in the leave approval channel can deny requests
        // No additional authorization check needed
        
        // Get the leave request
        const leaveRequest = await db.getLeaveRequest(requestId);
        if (!leaveRequest) {
            await client.chat.postEphemeral({
                channel: body.channel.id,
                user: denierId,
                text: "❌ Leave request not found."
            });
            return;
        }
        
        if (leaveRequest.status !== 'pending') {
            await client.chat.postEphemeral({
                channel: body.channel.id,
                user: denierId,
                text: `❌ This leave request has already been ${leaveRequest.status}.`
            });
            return;
        }
        
        // Get denier info
        const denierInfo = await client.users.info({ user: denierId });
        const denierName = denierInfo.user.real_name || denierInfo.user.name;
        
        // Update leave request status
        await db.updateLeaveRequestStatus(requestId, 'denied', denierId);
        
        // Notify user
        await client.chat.postMessage({
            channel: leaveRequest.user_id,
            text: `❌ *Leave Request Denied*\n\nYour ${leaveRequest.leave_type === 'intermediate' ? 'intermediate logout' : 'planned leave'} request has been denied by ${denierName}.\n📝 Reason: ${leaveRequest.reason}\n\nPlease discuss with your manager for more details.`
        });
        
        // Update the original message to show denial
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `❌ *Leave Request - ${leaveRequest.leave_type === 'intermediate' ? 'Intermediate Logout' : 'Planned Leave'}* (DENIED)`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `❌ *Leave Request - ${leaveRequest.leave_type === 'intermediate' ? 'Intermediate Logout' : 'Planned Leave'}* (DENIED)\n\n👤 *Employee:* ${leaveRequest.user_name}\n📝 *Reason:* ${leaveRequest.reason}\n\n❌ *Denied by:* ${denierName}\n⏰ *Denied at:* ${new Date().toLocaleString()}`
                    }
                }
            ]
        });
        
        // Send threaded reply for HR notification
        await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message.ts,
            text: `❌ *Denial Notification*\n\n${denierName} has denied this leave request at ${new Date().toLocaleString()}\n\n📋 <@${config.bot.hrTag}> - Please take appropriate steps for this denial.`
        });
        
    } catch (error) {
        console.error('Error denying leave:', error);
        await client.chat.postEphemeral({
            channel: body.channel.id,
            user: body.user.id,
            text: "❌ Error denying leave request. Please try again."
        });
    }
});

// ================================
// AUTOMATIC TIME EXCEEDED CHECKS
// ================================

// Send polite warning at 2.4 hours (144 minutes)
cron.schedule('* * * * *', async () => {
    try {
        // Get sessions that are at exactly 2.4 hours (144 minutes) - check within 1 minute window
        const activeSession = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT * FROM leave_sessions 
                WHERE end_time IS NULL 
                AND datetime('now') BETWEEN 
                    datetime(start_time, '+143 minutes') AND 
                    datetime(start_time, '+145 minutes')
                AND reason NOT LIKE '%[WARNING_SENT]%'`,
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

                // Send polite warning at 2.4 hours
                await app.client.chat.postMessage({
                    channel: session.user_id,
                    text: `🕐 *Gentle Reminder* 😊\n\nHi ${userName}! Just a friendly heads-up that you've been on intermediate logout for about 2.4 hours.\n\n📝 *Just so you know:* If you're away for more than 2.5 hours total, this will automatically be processed as half-day leave instead of intermediate logout.\n\n✅ *No action needed right now* - just wanted to keep you informed! When you're back, use \`/return\` to check in.\n\nHope everything is going well! 🌟`
                });

                console.log(`💡 Sent 2.4-hour gentle reminder to ${userName}`);

                // Mark warning as sent to prevent duplicate messages
                db.db.run(
                    `UPDATE leave_sessions SET reason = reason || ' [WARNING_SENT]' 
                    WHERE id = ?`,
                    [session.id]
                );

            } catch (error) {
                console.error(`Error sending warning to user ${session.user_id}:`, error);
            }
        }

    } catch (error) {
        console.error('Error in 2.4-hour warning check:', error);
    }
});

// Auto-convert to half-day leave when sessions exceed 2.5 hours
cron.schedule('*/5 * * * *', async () => {
    try {
        // Get sessions that have exceeded 2.5 hours and are still active
        const exceededSessions = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT * FROM leave_sessions 
                WHERE end_time IS NULL 
                AND datetime('now') > datetime(start_time, '+150 minutes')
                AND reason NOT LIKE '%[AUTO_CONVERTED]%'`,
                (err, sessions) => {
                    if (err) reject(err);
                    else resolve(sessions);
                }
            );
        });

        for (const session of exceededSessions) {
            try {
                const userInfo = await app.client.users.info({ user: session.user_id });
                const userName = userInfo.user.real_name || userInfo.user.name;
                const currentDuration = Math.round((new Date() - new Date(session.start_time)) / (1000 * 60));
                const actualDuration = Utils.formatDuration(currentDuration);

                // Auto-end the session
                const endedSession = await db.endLeaveSession(session.user_id);

                // Send polite notification to employee
                await app.client.chat.postMessage({
                    channel: session.user_id,
                    text: `🏠 *Auto Check-In Complete* 😊\n\nHi ${userName}! Since you've been away for ${actualDuration}, we've automatically checked you in and processed this as half-day leave.\n\n📝 *No worries at all* - this happens! Your time has been properly recorded.\n\n✅ *All set* - no further action needed from you.\n\nHope you had a productive time away! 🌟`
                });

                // Update transparency channel
                const message = Utils.formatLeaveEndMessage(userName, actualDuration);
                await app.client.chat.postMessage({
                    channel: config.bot.transparencyChannel,
                    text: `${message} *(Auto-converted to half-day leave)*`
                });

                // Inform HR about automatic conversion
                await app.client.chat.postMessage({
                    channel: config.bot.leaveApprovalChannel,
                    text: `ℹ️ *Auto-Conversion Complete - Half Day Leave*\n\n👤 *Employee:* ${userName}\n⏰ *Total time:* ${actualDuration}\n📝 *Status:* Automatically converted to half-day leave (exceeded 2.5h limit)\n\n📋 <@${config.bot.hrTag}> - FYI: This has been automatically processed as half-day leave.`
                });

                console.log(`🔄 Auto-converted ${userName}'s session to half-day leave`);

                // Mark as auto-converted
                db.db.run(
                    `UPDATE leave_sessions SET reason = reason || ' [AUTO_CONVERTED]' 
                    WHERE id = ?`,
                    [session.id]
                );

            } catch (error) {
                console.error(`Error auto-converting session for user ${session.user_id}:`, error);
            }
        }

    } catch (error) {
        console.error('Error in auto-conversion check:', error);
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
        console.log(`  • Max intermediate hours: ${config.bot.maxIntermediateHours}h`);
        console.log(`  • Transparency channel: ${config.bot.transparencyChannel}`);
        console.log(`  • Leave approval channel: ${config.bot.leaveApprovalChannel}`);
        console.log(`  • Leave approval access: Anyone in the ${config.bot.leaveApprovalChannel} channel`);
        console.log(`  • Leave approval tag: ${config.bot.leaveApprovalTag} (User ID required)`);
        console.log(`  • HR tag: ${config.bot.hrTag} (User ID required)`);
        console.log(`  • Admin notifications: ${config.notifications.notifyChannel ? '✅ ' + config.notifications.notifyChannel : '❌ Disabled'}`);
        console.log(`  • Admin password set: ${config.bot.adminPassword ? '✅' : '❌'}`);
        console.log(`  • Keepalive: ${RENDER_URL ? '✅ Enabled' : '❌ Disabled (add RENDER_URL env var)'}`);
        console.log('🚀 Available commands:');
        console.log('  /intermediate_logout <duration> <reason> - Start intermediate logout (requires approval)');
        console.log('  /planned - Request planned leave (requires approval)');
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