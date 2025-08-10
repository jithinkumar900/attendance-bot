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

// Connection state tracking to avoid excessive logging
let lastReconnectTime = 0;
let reconnectCount = 0;

// Handle Socket Mode connection errors gracefully
app.receiver.client.on('error', (error) => {
    if (error.message && error.message.includes('server explicit disconnect')) {
        const now = Date.now();
        if (now - lastReconnectTime > 30000) { // Only log every 30 seconds
            console.log('🔄 Slack connection interrupted, will reconnect automatically...');
            lastReconnectTime = now;
            reconnectCount = 0;
        }
    } else {
        console.error('⚠️ Socket Mode error:', error);
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    if (reason && reason.toString().includes('server explicit disconnect')) {
        const now = Date.now();
        reconnectCount++;
        if (now - lastReconnectTime > 30000) { // Only log every 30 seconds
            console.log(`🔄 Slack disconnection handled, continuing... (${reconnectCount} reconnects)`);
            lastReconnectTime = now;
            reconnectCount = 0;
        }
    } else {
        console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    }
});

// Handle uncaught exceptions (including the finity state machine error)
process.on('uncaughtException', (error) => {
    if (error.message && error.message.includes('server explicit disconnect')) {
        console.log('🔄 Socket disconnect error caught, bot will restart automatically...');
        // Don't exit on this specific error, let Render restart the service
        return;
    } else {
        console.error('❌ Uncaught Exception:', error);
        process.exit(1);
    }
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
    // Main keepalive - every 3 minutes (more aggressive)
    cron.schedule('*/3 * * * *', async () => {
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

// Handle /logout command (unified early logout and late login)
app.command('/logout', async ({ command, ack, client }) => {
    await ack();

    try {
        // Open selection modal to choose between early logout or late login
        await client.views.open({
            trigger_id: command.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'logout_selection_modal',
                title: { type: 'plain_text', text: 'Logout Request' },
                submit: { type: 'plain_text', text: 'Continue' },
                close: { type: 'plain_text', text: 'Cancel' },
                private_metadata: command.channel_id,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '🔄 *Select Request Type*\n\nWhat would you like to request?'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'request_type',
                        element: {
                            type: 'radio_buttons',
                            action_id: 'type_selection',
                            options: [
                                {
                                    text: { type: 'plain_text', text: '🏃‍♂️ Early Logout - Leave work before your standard end time' },
                                    value: 'early_logout'
                                },
                                {
                                    text: { type: 'plain_text', text: '🕐 Late Login - Started work after your standard start time' },
                                    value: 'late_login'
                                }
                            ]
                        },
                        label: { type: 'plain_text', text: 'Request Type' }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '💡 *Both requests require approval and may affect your work time balance*'
                            }
                        ]
                    }
                ]
            }
        });

    } catch (error) {
        console.error('Error in logout selection modal:', error);
        
        // Provide helpful error message
        let errorMessage = "Sorry, there was an error opening the logout form.";
        
        if (error.message && error.message.includes('timeout')) {
            errorMessage += " The service may be warming up. Please wait 10 seconds and try again.";
        } else if (!connectionWarmed) {
            errorMessage += " Connection is being established. Please try again in a moment.";
        }
        
        await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: `❌ ${errorMessage}`
        });
    }
});

// Handle logout selection modal submission
app.view('logout_selection_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const values = view.state.values;
        const requestType = values.request_type?.type_selection?.selected_option?.value;
        
        if (!requestType) {
            return {
                response_action: 'errors',
                errors: {
                    request_type: 'Please select a request type'
                }
            };
        }
        
        const channelId = view.private_metadata;
        
        if (requestType === 'early_logout') {
            // Open early logout modal
            await client.views.open({
                trigger_id: body.trigger_id,
                view: {
                    type: 'modal',
                    callback_id: 'early_logout_modal',
                    title: { type: 'plain_text', text: 'Early Logout Request' },
                    submit: { type: 'plain_text', text: 'Submit Request' },
                    close: { type: 'plain_text', text: 'Cancel' },
                    private_metadata: channelId,
                blocks: [
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: '🏃‍♂️ *Request Early Logout*\n\nPlease provide your work schedule and departure details:'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'early_logout_date',
                        element: {
                            type: 'datepicker',
                            action_id: 'early_date_select',
                            placeholder: { type: 'plain_text', text: 'Select early logout date' },
                            initial_date: new Date().toISOString().split('T')[0] // Today's date as default
                        },
                        label: { type: 'plain_text', text: '📅 Early Logout Date' }
                    },
                    {
                        type: 'input',
                        block_id: 'standard_end_time',
                        element: {
                            type: 'timepicker',
                            action_id: 'standard_end_time_select',
                            placeholder: { type: 'plain_text', text: 'Your normal work end time' }
                        },
                        label: { type: 'plain_text', text: '🕘 Your Standard Work End Time *' }
                    },
                    {
                        type: 'input',
                        block_id: 'early_departure_time',
                        element: {
                            type: 'timepicker',
                            action_id: 'early_departure_time_select',
                            placeholder: { type: 'plain_text', text: 'When you want to leave early' }
                        },
                        label: { type: 'plain_text', text: '🚪 Early Departure Time *' }
                    },
                    {
                        type: 'input',
                        block_id: 'early_reason',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'reason_input',
                            placeholder: { type: 'plain_text', text: 'Doctor appointment, family emergency, personal work, etc.' },
                            max_length: 200
                        },
                        label: { type: 'plain_text', text: '📝 Reason for Early Logout *' }
                    },
                    {
                        type: 'input',
                        block_id: 'task_escalation',
                        element: {
                            type: 'plain_text_input',
                            action_id: 'escalation_input',
                            multiline: true,
                            placeholder: { type: 'plain_text', text: 'Describe any pending tasks and who you are handing them over to (e.g., "Completing API testing - will hand over to @jane.doe for final review")' },
                            max_length: 3500
                        },
                        label: { type: 'plain_text', text: '🔄 Task Escalation/Handover *' }
                    },
                    {
                        type: 'context',
                        elements: [
                            {
                                type: 'mrkdwn',
                                text: '⚠️ *All fields are required* | 📊 *Time shortfall will be added to your pending work balance*'
                            }
                        ]
                    }
                ]
            }
        });
        } else if (requestType === 'late_login') {
            // Open late login modal
            await client.views.open({
                trigger_id: body.trigger_id,
                view: {
                    type: 'modal',
                    callback_id: 'late_login_modal',
                    title: { type: 'plain_text', text: 'Late Login Request' },
                    submit: { type: 'plain_text', text: 'Submit Request' },
                    close: { type: 'plain_text', text: 'Cancel' },
                    private_metadata: channelId,
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: '🕐 *Request Late Login*\n\nPlease provide your work schedule and login details:'
                            }
                        },
                        {
                            type: 'input',
                            block_id: 'late_login_date',
                            element: {
                                type: 'datepicker',
                                action_id: 'late_date_select',
                                placeholder: { type: 'plain_text', text: 'Select late login date' },
                                initial_date: new Date().toISOString().split('T')[0]
                            },
                            label: { type: 'plain_text', text: '📅 Late Login Date' }
                        },
                        {
                            type: 'input',
                            block_id: 'standard_start_time',
                            element: {
                                type: 'timepicker',
                                action_id: 'standard_start_time_select',
                                placeholder: { type: 'plain_text', text: 'Your normal work start time' }
                            },
                            label: { type: 'plain_text', text: '🕘 Your Standard Work Start Time *' }
                        },
                        {
                            type: 'input',
                            block_id: 'actual_login_time',
                            element: {
                                type: 'timepicker',
                                action_id: 'actual_login_time_select',
                                placeholder: { type: 'plain_text', text: 'When you actually logged in' }
                            },
                            label: { type: 'plain_text', text: '🚪 Actual Login Time *' }
                        },
                        {
                            type: 'input',
                            block_id: 'late_reason',
                            element: {
                                type: 'plain_text_input',
                                action_id: 'reason_input',
                                placeholder: { type: 'plain_text', text: 'Traffic, medical appointment, personal emergency, etc.' },
                                max_length: 200
                            },
                            label: { type: 'plain_text', text: '📝 Reason for Late Login *' }
                        },
                        {
                            type: 'input',
                            block_id: 'task_escalation',
                            element: {
                                type: 'plain_text_input',
                                action_id: 'escalation_input',
                                multiline: true,
                                placeholder: { type: 'plain_text', text: 'Describe any tasks affected by late start and coverage arrangements (e.g., "Morning meeting covered by @john.doe, client calls rescheduled")' },
                                max_length: 3500
                            },
                            label: { type: 'plain_text', text: '🔄 Task Escalation *' }
                        },
                        {
                            type: 'context',
                            elements: [
                                {
                                    type: 'mrkdwn',
                                    text: '⚠️ *All fields are required* | 📊 *Time shortfall will be added to your pending work balance*'
                                }
                            ]
                        }
                    ]
                }
            });
        }

    } catch (error) {
        console.error('Error in logout selection modal:', error);
        
        // Send error message to user
        await client.chat.postEphemeral({
            channel: body.view.private_metadata,
            user: body.user.id,
            text: "❌ Sorry, there was an error processing your request. Please try again."
        });
    }
});

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
                                max_length: 3500
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
                            text: '📅 *When will you take intermediate logout?*\n\nSelect the date and times for your leave:'
                        }
                    },
                    {
                        type: 'input',
                        block_id: 'leave_date',
                        element: {
                            type: 'datepicker',
                            action_id: 'leave_date_select',
                            placeholder: { type: 'plain_text', text: 'Select leave date' },
                            initial_date: new Date().toISOString().split('T')[0] // Today's date as default
                        },
                        label: { type: 'plain_text', text: '📅 Leave Date' }
                    },
                    {
                        type: 'input',
                        block_id: 'departure_time',
                        element: {
                            type: 'timepicker',
                            action_id: 'departure_time_select',
                            placeholder: { type: 'plain_text', text: 'Select departure time' }
                        },
                        label: { type: 'plain_text', text: '🚪 Departure Time' }
                    },
                    {
                        type: 'input',
                        block_id: 'return_time',
                        element: {
                            type: 'timepicker',
                            action_id: 'return_time_select',
                            placeholder: { type: 'plain_text', text: 'Select expected return time' }
                        },
                        label: { type: 'plain_text', text: '🔙 Expected Return Time' }
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
                            max_length: 3500
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
                            max_length: 3500
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
        if (error.message.includes('No active leave session')) {
            // This is not an error, just user trying to return without active session
            console.log(`ℹ️ User ${command.user_id} tried to return without active session`);
            await client.chat.postEphemeral({
                channel: command.channel_id,
                user: command.user_id,
                text: "ℹ️ You don't have an active leave session to end. Use `/review` to check your current status."
            });
        } else {
            // This is an actual error
            console.error('Error in return:', error);
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
        
        // Get future approved leave requests
        const futureLeave = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT * FROM leave_requests 
                WHERE user_id = ? 
                AND status = 'approved' 
                AND (start_date > date('now', 'localtime') OR (start_date = date('now', 'localtime') AND leave_type = 'planned'))
                ORDER BY start_date ASC`,
                [user_id],
                (err, requests) => {
                    if (err) reject(err);
                    else resolve(requests || []);
                }
            );
        });
        
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

        // Add future approved leave requests
        if (futureLeave.length > 0) {
            statusMessage += `📅 *Upcoming Approved Leave*\n`;
            futureLeave.forEach(request => {
                if (request.leave_type === 'planned') {
                    const startDate = Utils.formatDate(request.start_date);
                    const endDate = Utils.formatDate(request.end_date);
                    const dateRange = startDate === endDate ? startDate : `${startDate} - ${endDate}`;
                    statusMessage += `• ${dateRange}: ${Utils.formatLeaveType(request.leave_duration_days > 1 ? 'full_day' : 'half_day')} - ${request.reason}\n`;
                } else {
                    statusMessage += `• Intermediate Logout: ${Utils.formatDuration(request.planned_duration)} - ${request.reason}\n`;
                }
            });
            statusMessage += `\n`;
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
        
        // If no activity at all (including no future leave)
        if (!activeLeave && !activeExtraWork && futureLeave.length === 0 && (!summary || (summary.total_leave_minutes === 0 && summary.total_extra_work_minutes === 0))) {
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

        // Get future approved leave requests (next 30 days)
        const futureLeaveRequests = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT lr.*, u.name as user_name FROM leave_requests lr
                JOIN users u ON lr.user_id = u.id
                WHERE lr.status = 'approved' 
                AND lr.start_date > date('now', 'localtime')
                AND lr.start_date <= date('now', 'localtime', '+30 days')
                ORDER BY lr.start_date ASC`,
                (err, requests) => {
                    if (err) reject(err);
                    else resolve(requests || []);
                }
            );
        });

        return {
            activeLeave,
            activeExtraWork,
            pendingWork,
            recentActivity,
            futureLeaveRequests
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
        
        // Get leave date and times
        const leaveDate = values.leave_date?.leave_date_select?.selected_date;
        const departureTime = values.departure_time?.departure_time_select?.selected_time;
        const returnTime = values.return_time?.return_time_select?.selected_time;
        
        // Get reason (optional)
        const reason = values.leave_reason?.reason_input?.value?.trim() || 'Intermediate logout';
        
        // Get task escalation (required)
        const taskEscalation = values.task_escalation?.escalation_input?.value?.trim() || '';
        
        // Validate date and times
        if (!leaveDate || !departureTime || !returnTime) {
            return {
                response_action: 'errors',
                errors: {
                    leave_date: !leaveDate ? 'Please select a leave date' : '',
                    departure_time: !departureTime ? 'Please select a departure time' : '',
                    return_time: !returnTime ? 'Please select a return time' : ''
                }
            };
        }
        
        // Validate that the leave date is not in the past
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const selectedDate = new Date(leaveDate);
        
        if (selectedDate < today) {
            return {
                response_action: 'errors',
                errors: {
                    leave_date: 'Leave date cannot be in the past'
                }
            };
        }
        
        // Parse times and calculate duration
        const departureDateTime = new Date(leaveDate + 'T' + departureTime);
        const returnDateTime = new Date(leaveDate + 'T' + returnTime);
        
        // Check if return time is after departure time
        if (returnDateTime <= departureDateTime) {
            return {
                response_action: 'errors',
                errors: {
                    return_time: 'Return time must be after departure time'
                }
            };
        }
        
        // Calculate duration in minutes
        const durationMinutes = Math.round((returnDateTime - departureDateTime) / (1000 * 60));
        
        // Validate duration (minimum 15 minutes, maximum 8 hours)
        if (durationMinutes < 15) {
            return {
                response_action: 'errors',
                errors: {
                    return_time: 'Duration must be at least 15 minutes'
                }
            };
        }
        
        if (durationMinutes > 480) { // 8 hours
            return {
                response_action: 'errors',
                errors: {
                    return_time: 'Duration cannot exceed 8 hours'
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
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;
        
        // Create user in database if not exists
        await db.createUser(user_id, userName, userInfo.user.profile?.email);
        
        // Format date and times for display
        const formattedLeaveDate = Utils.formatDate(leaveDate);
        const formattedDepartureTime = Utils.formatTime12Hour(departureTime);
        const formattedReturnTime = Utils.formatTime12Hour(returnTime);
        const formattedDuration = Utils.formatDuration(durationMinutes);
        
        // Create full date-time strings for display
        const isToday = leaveDate === new Date().toISOString().split('T')[0];
        const departureDisplay = isToday ? formattedDepartureTime : `${formattedLeaveDate} at ${formattedDepartureTime}`;
        const returnDisplay = isToday ? formattedReturnTime : `${formattedLeaveDate} at ${formattedReturnTime}`;
        
        // Create leave request for approval
        const requestId = await db.createLeaveRequest(
            user_id, 
            userName, 
            'intermediate', 
            reason, 
            taskEscalation, 
            {
                plannedDuration: durationMinutes,
                expectedReturnTime: returnDisplay,
                departureTime: departureDisplay,
                leaveDate: leaveDate
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
                        text: `🔄 *Leave Request - Intermediate Logout*\n\n👤 *Employee:* ${userName}\n${!isToday ? `📅 *Date:* ${formattedLeaveDate}\n` : ''}🚪 *Departure:* ${isToday ? formattedDepartureTime : `${formattedDepartureTime}`}\n🔙 *Expected Return:* ${isToday ? formattedReturnTime : `${formattedReturnTime}`}\n⏰ *Duration:* ${formattedDuration}\n📝 *Reason:* ${reason}\n\n🔄 *Task Escalation:*\n${taskEscalation}\n\n📋 <@${config.bot.leaveApprovalTag}> - Please review this leave request.`
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
        let successMessage = `✅ *Leave request submitted successfully!*\n\n${!isToday ? `📅 Date: ${formattedLeaveDate}\n` : ''}🚪 Departure: ${departureDisplay}\n🔙 Expected return: ${returnDisplay}\n⏰ Duration: ${formattedDuration}\n📝 Reason: ${reason}`;
        
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

// Handle early logout modal submission
app.view('early_logout_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const user_id = body.user.id;
        
        // Extract values from the modal
        const values = view.state.values;
        
        // Get date and times
        const earlyDate = values.early_logout_date?.early_date_select?.selected_date;
        const standardEndTime = values.standard_end_time?.standard_end_time_select?.selected_time;
        const earlyDepartureTime = values.early_departure_time?.early_departure_time_select?.selected_time;
        
        // Get reason and task escalation
        const reason = values.early_reason?.reason_input?.value?.trim();
        const taskEscalation = values.task_escalation?.escalation_input?.value?.trim();
        
        // Validate all required fields
        if (!earlyDate || !standardEndTime || !earlyDepartureTime || !reason || !taskEscalation) {
            return {
                response_action: 'errors',
                errors: {
                    early_logout_date: !earlyDate ? 'Please select an early logout date' : '',
                    standard_end_time: !standardEndTime ? 'Please specify your standard work end time' : '',
                    early_departure_time: !earlyDepartureTime ? 'Please specify when you want to leave early' : '',
                    early_reason: !reason ? 'Please provide a reason for early logout' : '',
                    task_escalation: !taskEscalation ? 'Task escalation is required' : ''
                }
            };
        }
        
        // Validate that the early date is not in the past
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const selectedDate = new Date(earlyDate);
        
        if (selectedDate < today) {
            return {
                response_action: 'errors',
                errors: {
                    early_logout_date: 'Early logout date cannot be in the past'
                }
            };
        }
        
        // Validate that early departure is before standard end time
        const shortfallMinutes = Utils.calculateShortfallMinutes(standardEndTime, earlyDepartureTime);
        
        if (shortfallMinutes <= 0) {
            return {
                response_action: 'errors',
                errors: {
                    early_departure_time: 'Early departure time must be before your standard work end time'
                }
            };
        }
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;
        
        // Create user in database if not exists
        await db.createUser(user_id, userName, userInfo.user.profile?.email);
        
        // Format times for display
        const formattedStandardEndTime = Utils.formatTime12Hour(standardEndTime);
        const formattedEarlyDepartureTime = Utils.formatTime12Hour(earlyDepartureTime);
        const formattedShortfall = Utils.formatDuration(shortfallMinutes);
        const formattedDate = Utils.formatDate(earlyDate);
        
        // Create leave request for approval
        const requestId = await db.createLeaveRequest(
            user_id,
            userName,
            'early',
            reason,
            taskEscalation,
            {
                leaveDate: earlyDate,
                standardEndTime: formattedStandardEndTime,
                shortfallMinutes: shortfallMinutes,
                departureTime: formattedEarlyDepartureTime
            }
        );
        
        // Send approval request to leave-approval channel with interactive buttons
        const isToday = earlyDate === new Date().toISOString().split('T')[0];
        const approvalMessage = {
            text: `🏃‍♂️ *Leave Request - Early Logout*`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `🏃‍♂️ *Leave Request - Early Logout*\n\n👤 *Employee:* ${userName}\n${!isToday ? `📅 *Date:* ${formattedDate}\n` : ''}🕘 *Standard End:* ${formattedStandardEndTime}\n🚪 *Early Departure:* ${formattedEarlyDepartureTime}\n⏰ *Time Shortfall:* ${formattedShortfall}\n📝 *Reason:* ${reason}\n\n🔄 *Task Escalation:*\n${taskEscalation}\n\n📋 <@${config.bot.leaveApprovalTag}> - Please review this early logout request.`
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
        let successMessage = `✅ *Early logout request submitted successfully!*\n\n${!isToday ? `📅 Date: ${formattedDate}\n` : ''}🕘 Standard End: ${formattedStandardEndTime}\n🚪 Early Departure: ${formattedEarlyDepartureTime}\n⏰ Time Shortfall: ${formattedShortfall}\n📝 Reason: ${reason}`;
        
        if (taskEscalation) {
            successMessage += `\n🔄 Task Escalation: ${taskEscalation}`;
        }
        
        successMessage += `\n\n📋 Your request has been sent to ${config.bot.leaveApprovalChannel} for manager approval.\n📊 Upon approval, ${formattedShortfall} will be added to your pending work balance.`;
        
        // Send confirmation in the channel where user requested
        const channelId = body.view.private_metadata;
        await client.chat.postMessage({
            channel: channelId,
            text: `📋 *Early Logout Request Submitted*\n\n${userName} has submitted an early logout request and is awaiting approval.`
        });
        
        await client.chat.postEphemeral({
            channel: channelId,
            user: user_id,
            text: successMessage
        });
        
    } catch (error) {
        console.error('Error processing early logout modal:', error);
        
        // Send error message to user
        await client.chat.postEphemeral({
            channel: config.bot.transparencyChannel,
            user: body.user.id,
            text: "❌ Sorry, there was an error submitting your early logout request. Please try again."
        });
    }
});

// Handle late login modal submission
app.view('late_login_modal', async ({ ack, body, client, view }) => {
    await ack();
    
    try {
        const user_id = body.user.id;
        
        // Extract values from the modal
        const values = view.state.values;
        
        // Get date and times
        const lateDate = values.late_login_date?.late_date_select?.selected_date;
        const standardStartTime = values.standard_start_time?.standard_start_time_select?.selected_time;
        const actualLoginTime = values.actual_login_time?.actual_login_time_select?.selected_time;
        
        // Get reason and task escalation
        const reason = values.late_reason?.reason_input?.value?.trim();
        const taskEscalation = values.task_escalation?.escalation_input?.value?.trim();
        
        // Validate all required fields
        if (!lateDate || !standardStartTime || !actualLoginTime || !reason || !taskEscalation) {
            return {
                response_action: 'errors',
                errors: {
                    late_login_date: !lateDate ? 'Please select a late login date' : '',
                    standard_start_time: !standardStartTime ? 'Please specify your standard work start time' : '',
                    actual_login_time: !actualLoginTime ? 'Please specify when you actually logged in' : '',
                    late_reason: !reason ? 'Please provide a reason for late login' : '',
                    task_escalation: !taskEscalation ? 'Task escalation is required' : ''
                }
            };
        }
        
        // Validate that the late date is not in the future
        const today = new Date();
        today.setHours(23, 59, 59, 999); // End of today
        const selectedDate = new Date(lateDate);
        
        if (selectedDate > today) {
            return {
                response_action: 'errors',
                errors: {
                    late_login_date: 'Late login date cannot be in the future'
                }
            };
        }
        
        // Validate that actual login is after standard start time
        const shortfallMinutes = Utils.calculateLateLoginShortfall(standardStartTime, actualLoginTime);
        
        if (shortfallMinutes <= 0) {
            return {
                response_action: 'errors',
                errors: {
                    actual_login_time: 'Actual login time must be after your standard start time'
                }
            };
        }
        
        // Get user info
        const userInfo = await client.users.info({ user: user_id });
        const userName = userInfo.user.real_name || userInfo.user.name;
        
        // Create user in database if not exists
        await db.createUser(user_id, userName, userInfo.user.profile?.email);
        
        // Format times for display
        const formattedStandardStartTime = Utils.formatTime12Hour(standardStartTime);
        const formattedActualLoginTime = Utils.formatTime12Hour(actualLoginTime);
        const formattedShortfall = Utils.formatDuration(shortfallMinutes);
        const formattedDate = Utils.formatDate(lateDate);
        
        // Create leave request for approval
        const requestId = await db.createLeaveRequest(
            user_id,
            userName,
            'late',
            reason,
            taskEscalation,
            {
                leaveDate: lateDate,
                standardStartTime: formattedStandardStartTime,
                actualLoginTime: formattedActualLoginTime,
                shortfallMinutes: shortfallMinutes
            }
        );
        
        // Send approval request to leave-approval channel with interactive buttons
        const isToday = lateDate === new Date().toISOString().split('T')[0];
        const approvalMessage = {
            text: `🕐 *Leave Request - Late Login*`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `🕐 *Leave Request - Late Login*\n\n👤 *Employee:* ${userName}\n${!isToday ? `📅 *Date:* ${formattedDate}\n` : ''}🕘 *Standard Start:* ${formattedStandardStartTime}\n🚪 *Actual Login:* ${formattedActualLoginTime}\n⏰ *Time Shortfall:* ${formattedShortfall}\n📝 *Reason:* ${reason}\n\n🔄 *Task Escalation:*\n${taskEscalation}\n\n📋 <@${config.bot.leaveApprovalTag}> - Please review this late login request.`
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
        let successMessage = `✅ *Late login request submitted successfully!*\n\n${!isToday ? `📅 Date: ${formattedDate}\n` : ''}🕘 Standard Start: ${formattedStandardStartTime}\n🚪 Actual Login: ${formattedActualLoginTime}\n⏰ Time Shortfall: ${formattedShortfall}\n📝 Reason: ${reason}`;
        
        if (taskEscalation) {
            successMessage += `\n🔄 Task Escalation: ${taskEscalation}`;
        }
        
        successMessage += `\n\n📋 Your request has been sent to ${config.bot.leaveApprovalChannel} for manager approval.\n📊 Upon approval, ${formattedShortfall} will be added to your pending work balance.`;
        
        // Send confirmation in the channel where user requested
        const channelId = body.view.private_metadata;
        await client.chat.postMessage({
            channel: channelId,
            text: `📋 *Late Login Request Submitted*\n\n${userName} has submitted a late login request and is awaiting approval.`
        });
        
        await client.chat.postEphemeral({
            channel: channelId,
            user: user_id,
            text: successMessage
        });
        
    } catch (error) {
        console.error('Error processing late login modal:', error);
        
        // Send error message to user
        await client.chat.postEphemeral({
            channel: config.bot.transparencyChannel,
            user: body.user.id,
            text: "❌ Sorry, there was an error submitting your late login request. Please try again."
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
        if (error.message.includes('No active extra work session')) {
            // This is not an error, just user trying to end work without active session
            console.log(`ℹ️ User ${body.user.id} tried to end work without active session`);
            await client.chat.postMessage({
                channel: body.user.id,
                text: "ℹ️ No active extra work session found. You may have already ended it or never started one."
            });
        } else {
            // This is an actual error
            console.error('Error in work end modal:', error);
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
        
        // For intermediate logout, handle immediate vs scheduled departure
        if (leaveRequest.leave_type === 'intermediate') {
            const now = new Date();
            const today = now.toISOString().split('T')[0];
            const departureTime = leaveRequest.departure_time;
            const leaveDate = leaveRequest.leave_date || today; // Default to today for legacy requests
            
            // Check if departure is immediate (today and within next 15 minutes) or scheduled
            let isImmediate = false;
            let isFutureDate = leaveDate !== today;
            
            if (!isFutureDate && departureTime) {
                // Same day - check time proximity
                const timeOnly = departureTime.includes(' at ') ? 
                    departureTime.split(' at ')[1] : departureTime;
                const departureDateTime = new Date(today + 'T' + Utils.parseTimeString(timeOnly));
                const timeDiff = departureDateTime - now;
                isImmediate = timeDiff <= 15 * 60 * 1000; // 15 minutes or less
            } else if (!departureTime) {
                isImmediate = true; // Legacy format, start immediately
            }
            
            if (isImmediate) {
                // Start the leave session immediately
                await db.startLeaveSession(leaveRequest.user_id, leaveRequest.planned_duration, leaveRequest.reason);
                
                // Send transparency message
                const returnTime = leaveRequest.expected_return_time;
                const formattedDuration = Utils.formatDuration(leaveRequest.planned_duration);
                const message = Utils.formatLeaveTransparencyMessage(
                    leaveRequest.user_name, 
                    formattedDuration, 
                    leaveRequest.reason, 
                    returnTime, 
                    leaveRequest.task_escalation,
                    leaveRequest.departure_time || null
                );
                
                await client.chat.postMessage({
                    channel: config.bot.transparencyChannel,
                    text: message
                });
                
                // Notify user
                await client.chat.postMessage({
                    channel: leaveRequest.user_id,
                    text: `✅ *Leave Approved!*\n\nYour intermediate logout request has been approved by ${approverName}.\n🚪 Departure: ${leaveRequest.departure_time || 'Now'}\n🔙 Expected return: ${leaveRequest.expected_return_time}\n⏰ Duration: ${Utils.formatDuration(leaveRequest.planned_duration)}\n\nYour leave has started automatically. Use \`/return\` when you're back!`
                });
            } else {
                // Scheduled departure (future date or future time) - just notify user, don't start session yet
                const scheduleText = isFutureDate ? 
                    `on ${Utils.formatDate(leaveDate)} at ${departureTime.includes(' at ') ? departureTime.split(' at ')[1] : departureTime}` :
                    `at ${departureTime}`;
                
                await client.chat.postMessage({
                    channel: leaveRequest.user_id,
                    text: `✅ *Leave Approved!*\n\nYour intermediate logout request has been approved by ${approverName}.\n🚪 Scheduled departure: ${leaveRequest.departure_time}\n🔙 Expected return: ${leaveRequest.expected_return_time}\n⏰ Duration: ${Utils.formatDuration(leaveRequest.planned_duration)}\n\n⏰ Your leave session will start automatically ${scheduleText}. You'll receive a notification then.`
                });
                
                // TODO: Implement scheduled departure logic (cron job or delayed task)
                console.log(`📅 Scheduled departure for ${leaveRequest.user_name} ${scheduleText}`);
            }
        } else if (leaveRequest.leave_type === 'early') {
            // For early logout, add shortfall to pending work and post to transparency channel
            const shortfallMinutes = leaveRequest.shortfall_minutes || 0;
            const formattedShortfall = Utils.formatDuration(shortfallMinutes);
            
            // Add shortfall to user's pending extra work balance
            if (shortfallMinutes > 0) {
                const today = Utils.getCurrentDate();
                await db.addToPendingWork(leaveRequest.user_id, today, shortfallMinutes);
            }
            
            // Post early logout approval to transparency channel
            const earlyLogoutMessage = Utils.formatEarlyLogoutMessage(
                leaveRequest.user_name,
                leaveRequest.leave_date || Utils.getCurrentDate(),
                leaveRequest.standard_end_time,
                leaveRequest.departure_time,
                shortfallMinutes,
                leaveRequest.reason,
                leaveRequest.task_escalation
            );
            
            await client.chat.postMessage({
                channel: config.bot.transparencyChannel,
                text: earlyLogoutMessage
            });
            
            // Notify user
            const isToday = leaveRequest.leave_date === Utils.getCurrentDate();
            const dateDisplay = isToday ? 'Today' : Utils.formatDate(leaveRequest.leave_date);
            
            await client.chat.postMessage({
                channel: leaveRequest.user_id,
                text: `✅ *Early Logout Approved!*\n\nYour early logout request has been approved by ${approverName}.\n📅 Date: ${dateDisplay}\n🚪 Early Departure: ${leaveRequest.departure_time}\n🕘 Standard End: ${leaveRequest.standard_end_time}\n⏰ Time Shortfall: ${formattedShortfall}\n\n📊 ${formattedShortfall} has been added to your pending work balance.`
            });
        } else if (leaveRequest.leave_type === 'late') {
            // For late login, add shortfall to pending work and post to transparency channel
            const shortfallMinutes = leaveRequest.shortfall_minutes || 0;
            const formattedShortfall = Utils.formatDuration(shortfallMinutes);
            
            // Add shortfall to user's pending extra work balance
            if (shortfallMinutes > 0) {
                const today = Utils.getCurrentDate();
                await db.addToPendingWork(leaveRequest.user_id, today, shortfallMinutes);
            }
            
            // Post late login approval to transparency channel
            const lateLoginMessage = Utils.formatLateLoginMessage(
                leaveRequest.user_name,
                leaveRequest.leave_date || Utils.getCurrentDate(),
                leaveRequest.standard_start_time,
                leaveRequest.actual_login_time,
                shortfallMinutes,
                leaveRequest.reason,
                leaveRequest.task_escalation
            );
            
            await client.chat.postMessage({
                channel: config.bot.transparencyChannel,
                text: lateLoginMessage
            });
            
            // Notify user
            const isToday = leaveRequest.leave_date === Utils.getCurrentDate();
            const dateDisplay = isToday ? 'Today' : Utils.formatDate(leaveRequest.leave_date);
            
            await client.chat.postMessage({
                channel: leaveRequest.user_id,
                text: `✅ *Late Login Approved!*\n\nYour late login request has been approved by ${approverName}.\n📅 Date: ${dateDisplay}\n🚪 Actual Login: ${leaveRequest.actual_login_time}\n🕘 Standard Start: ${leaveRequest.standard_start_time}\n⏰ Time Shortfall: ${formattedShortfall}\n\n📊 ${formattedShortfall} has been added to your pending work balance.`
            });
        } else {
            // For planned leave, post to transparency channel and notify user
            const dateRange = leaveRequest.start_date === leaveRequest.end_date ? 
                Utils.formatDate(leaveRequest.start_date) : 
                `${Utils.formatDate(leaveRequest.start_date)} - ${Utils.formatDate(leaveRequest.end_date)}`;
            
            // Post planned leave approval to transparency channel
            const plannedLeaveMessage = Utils.formatPlannedLeaveMessage(
                leaveRequest.user_name, 
                'full_day', // Default to full day for now
                dateRange, 
                leaveRequest.leave_duration_days,
                leaveRequest.reason, 
                leaveRequest.task_escalation
            );
            
            await client.chat.postMessage({
                channel: config.bot.transparencyChannel,
                text: plannedLeaveMessage
            });
            
            // Notify user
            await client.chat.postMessage({
                channel: leaveRequest.user_id,
                text: `✅ *Leave Approved!*\n\nYour planned leave request has been approved by ${approverName}.\n📅 Dates: ${dateRange}\n📝 Reason: ${leaveRequest.reason}`
            });
        }
        
        // Update the original message to show approval
        const leaveTypeDisplay = leaveRequest.leave_type === 'intermediate' ? 'Intermediate Logout' : 
                                leaveRequest.leave_type === 'early' ? 'Early Logout' : 
                                leaveRequest.leave_type === 'late' ? 'Late Login' : 'Planned Leave';
        
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `✅ *Leave Request - ${leaveTypeDisplay}* (APPROVED)`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `✅ *Leave Request - ${leaveTypeDisplay}* (APPROVED)\n\n👤 *Employee:* ${leaveRequest.user_name}\n📝 *Reason:* ${leaveRequest.reason}\n\n✅ *Approved by:* ${approverName}\n⏰ *Approved at:* ${Utils.getCurrentIST()}`
                    }
                }
            ]
        });
        
        // Send threaded reply for HR notification  
        await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message.ts,
            text: `✅ *Approval Notification*\n\n${approverName} has approved this leave request at ${Utils.getCurrentIST()}\n\n📋 <@${config.bot.hrTag}> - Please take appropriate steps for this approval.`
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
        const leaveTypeText = leaveRequest.leave_type === 'intermediate' ? 'intermediate logout' :
                             leaveRequest.leave_type === 'early' ? 'early logout' : 
                             leaveRequest.leave_type === 'late' ? 'late login' : 'planned leave';
        
        await client.chat.postMessage({
            channel: leaveRequest.user_id,
            text: `❌ *Leave Request Denied*\n\nYour ${leaveTypeText} request has been denied by ${denierName}.\n📝 Reason: ${leaveRequest.reason}\n\nPlease discuss with your manager for more details.`
        });
        
        // Update the original message to show denial
        const leaveTypeDisplay = leaveRequest.leave_type === 'intermediate' ? 'Intermediate Logout' :
                                leaveRequest.leave_type === 'early' ? 'Early Logout' : 
                                leaveRequest.leave_type === 'late' ? 'Late Login' : 'Planned Leave';
        
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `❌ *Leave Request - ${leaveTypeDisplay}* (DENIED)`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `❌ *Leave Request - ${leaveTypeDisplay}* (DENIED)\n\n👤 *Employee:* ${leaveRequest.user_name}\n📝 *Reason:* ${leaveRequest.reason}\n\n❌ *Denied by:* ${denierName}\n⏰ *Denied at:* ${Utils.getCurrentIST()}`
                    }
                }
            ]
        });
        
        // Send threaded reply for HR notification
        await client.chat.postMessage({
            channel: body.channel.id,
            thread_ts: body.message.ts,
            text: `❌ *Denial Notification*\n\n${denierName} has denied this leave request at ${Utils.getCurrentIST()}\n\n📋 <@${config.bot.hrTag}> - Please take appropriate steps for this denial.`
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

// Send gentle reminders every 30 minutes after planned time until 2.4 hours
cron.schedule('*/30 * * * *', async () => {
    try {
        // Get sessions that have exceeded planned time but haven't reached 2.4 hours
        const activeSession = await new Promise((resolve, reject) => {
            db.db.all(
                `SELECT * FROM leave_sessions 
                WHERE end_time IS NULL 
                AND datetime('now') > datetime(start_time, '+' || planned_duration || ' minutes')
                AND datetime('now') < datetime(start_time, '+144 minutes')`,
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

                // Check if we've already sent a reminder in the last 25 minutes to avoid spam
                const lastReminderKey = `REMINDER_${session.id}_${Math.floor(currentDuration / 30)}`;
                if (session.reason && session.reason.includes(lastReminderKey)) {
                    continue; // Skip if we've already sent this reminder
                }

                // Send gentle reminder
                await app.client.chat.postMessage({
                    channel: session.user_id,
                    text: `🕐 *Gentle Reminder* 😊\n\nHi ${userName}! Just a friendly check-in - you've been on intermediate logout for ${actualDuration}, which is a bit longer than your planned ${plannedDuration}.\n\n✅ *No worries at all!* Things happen and we understand.\n\n📝 *Just so you know:* When you're ready, use \`/return\` to check back in. If you're away for more than 2.5 hours total, it'll automatically be processed as half-day leave.\n\nHope everything is going well! 🌟`
                });

                console.log(`💬 Sent gentle reminder to ${userName} (${actualDuration} elapsed)`);

                // Mark this specific reminder as sent
                db.db.run(
                    `UPDATE leave_sessions SET reason = reason || ' [${lastReminderKey}]' 
                    WHERE id = ?`,
                    [session.id]
                );

            } catch (error) {
                console.error(`Error sending reminder to user ${session.user_id}:`, error);
            }
        }

    } catch (error) {
        console.error('Error in reminder check:', error);
    }
});

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
                AND reason NOT LIKE '%[FINAL_WARNING_SENT]%'`,
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

                // Send polite final warning at 2.4 hours
                await app.client.chat.postMessage({
                    channel: session.user_id,
                    text: `🕐 *Final Gentle Reminder* 😊\n\nHi ${userName}! You've been on intermediate logout for about 2.4 hours now.\n\n📝 *Just a heads-up:* In about 6 more minutes (at 2.5 hours), this will automatically be processed as half-day leave instead of intermediate logout.\n\n✅ *Totally fine either way!* Just wanted to keep you informed. When you're ready, use \`/return\` to check back in.\n\nHope everything is going smoothly! 🌟`
                });

                console.log(`⚠️ Sent 2.4-hour final reminder to ${userName}`);

                // Mark final warning as sent to prevent duplicate messages
                db.db.run(
                    `UPDATE leave_sessions SET reason = reason || ' [FINAL_WARNING_SENT]' 
                    WHERE id = ?`,
                    [session.id]
                );

            } catch (error) {
                console.error(`Error sending final warning to user ${session.user_id}:`, error);
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

// Startup function with retry logic
async function startApp(retryCount = 0) {
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
        console.log('  /logout - Request early logout or late login (requires approval)');
        console.log('  /intermediate_logout <duration> <reason> - Start intermediate logout (requires approval)');
        console.log('  /planned - Request planned leave (requires approval)');
        console.log('  /return - End current leave');
        console.log('  /work-start [reason] - Start extra work session');
        console.log('  /work-end - End extra work session');
        console.log('  /review - Check today\'s summary');
        console.log('  /admin <password> - Admin report');
        
    } catch (error) {
        if (error.message && error.message.includes('server explicit disconnect') && retryCount < 3) {
            console.log(`🔄 Socket connection failed, retrying in 5 seconds... (attempt ${retryCount + 1}/3)`);
            setTimeout(() => startApp(retryCount + 1), 5000);
        } else {
            console.error('❌ Error starting the app:', error);
            process.exit(1);
        }
    }
}

// Start the app
startApp();

// Graceful shutdown handling
const gracefulShutdown = (signal) => {
    console.log(`🛑 Received ${signal}, gracefully shutting down...`);
    try {
        if (app && app.receiver && app.receiver.client) {
            app.receiver.client.disconnect();
        }
        if (db) {
            db.close();
        }
        console.log('✅ Shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
};

// Listen for shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
 