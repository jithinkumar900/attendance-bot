const moment = require('moment-timezone');

class Utils {
    // Parse duration strings like "1.5h", "30m", "2h30m"
    static parseDuration(durationStr) {
        const str = durationStr.toLowerCase().trim();
        let totalMinutes = 0;

        // Match patterns like "1.5h", "2h", "30m", "1h30m"
        const hourMatch = str.match(/(\d+(?:\.\d+)?)h/);
        const minuteMatch = str.match(/(\d+)m/);

        if (hourMatch) {
            totalMinutes += parseFloat(hourMatch[1]) * 60;
        }
        
        if (minuteMatch) {
            totalMinutes += parseInt(minuteMatch[1]);
        }

        // If no matches, try to parse as plain number (assume hours)
        if (!hourMatch && !minuteMatch) {
            const num = parseFloat(str);
            if (!isNaN(num)) {
                totalMinutes = num * 60;
            }
        }

        return Math.round(totalMinutes);
    }

    // Format minutes to human readable format
    static formatDuration(minutes) {
        if (minutes < 60) {
            return `${minutes}m`;
        }
        
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        
        if (remainingMinutes === 0) {
            return `${hours}h`;
        }
        
        return `${hours}h ${remainingMinutes}m`;
    }

    // Calculate return time based on current time and duration
    static calculateReturnTime(durationMinutes) {
        const now = moment().tz('Asia/Kolkata');
        const returnTime = now.clone().add(durationMinutes, 'minutes');
        return returnTime.format('h:mm A');
    }

    // Calculate actual duration between two timestamps
    static calculateActualDuration(startTime, endTime) {
        const start = moment(startTime);
        const end = moment(endTime);
        return end.diff(start, 'minutes');
    }

    // Get current date in YYYY-MM-DD format
    static getCurrentDate() {
        return moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
    }

    // Get current time in ISO format
    static getCurrentTime() {
        return moment().tz('Asia/Kolkata').toISOString();
    }

    // Format time for display
    static formatTime(timestamp) {
        return moment(timestamp).tz('Asia/Kolkata').format('h:mm A');
    }

    // Format date for display
    static formatDate(date) {
        return moment(date).format('MMM DD, YYYY');
    }

    // Check if time exceeds threshold
    static exceedsThreshold(minutes, thresholdHours) {
        return minutes > (thresholdHours * 60);
    }

    // Calculate working days between two dates
    static getWorkingDaysBetween(startDate, endDate) {
        const start = moment(startDate);
        const end = moment(endDate);
        let workingDays = 0;
        
        while (start.isSameOrBefore(end)) {
            if (start.day() !== 0 && start.day() !== 6) { // Not Sunday or Saturday
                workingDays++;
            }
            start.add(1, 'day');
        }
        
        return workingDays;
    }

    // Get deadline date
    static getDeadlineDate(days) {
        return moment().add(days, 'days').format('MMM DD, YYYY');
    }

    // Check if deadline is approaching (within 2 days)
    static isDeadlineApproaching(dateStr, deadlineDays) {
        const targetDate = moment(dateStr).add(deadlineDays, 'days');
        const daysLeft = targetDate.diff(moment(), 'days');
        return daysLeft <= 2;
    }

    // Validate admin password
    static validateAdminPassword(inputPassword, configPassword) {
        return inputPassword === configPassword;
    }

    // Generate admin report format
    static formatAdminReport(data, startDate, endDate) {
        let report = `📈 *ADMIN REPORT* (${startDate} to ${endDate})\n`;
        report += `${'='.repeat(50)}\n\n`;

        if (data.length === 0) {
            report += "No data found for the specified period.";
            return report;
        }

        // Summary statistics
        const totalUsers = data.length;
        const totalLeaveMinutes = data.reduce((sum, user) => sum + user.total_leave_minutes, 0);
        const totalExtraWorkMinutes = data.reduce((sum, user) => sum + user.total_extra_work_minutes, 0);
        const totalPendingMinutes = data.reduce((sum, user) => sum + user.total_pending_minutes, 0);

        report += `*SUMMARY:*\n`;
        report += `• Total Users: ${totalUsers}\n`;
        report += `• Total Leave Time: ${this.formatDuration(totalLeaveMinutes)}\n`;
        report += `• Total Extra Work Time: ${this.formatDuration(totalExtraWorkMinutes)}\n`;
        report += `• Total Pending Time: ${this.formatDuration(totalPendingMinutes)}\n\n`;

        report += `*USER DETAILS:*\n`;
        report += `${'─'.repeat(80)}\n`;

        data.forEach((user, index) => {
            const leaveTime = this.formatDuration(user.total_leave_minutes || 0);
            const extraWorkTime = this.formatDuration(user.total_extra_work_minutes || 0);
            const pendingTime = this.formatDuration(user.total_pending_minutes || 0);
            
            report += `${index + 1}. *${user.name}*\n`;
            report += `   • Leave Sessions: ${user.total_leave_sessions} (${leaveTime})\n`;
            report += `   • Extra Work Sessions: ${user.total_extra_work_sessions} (${extraWorkTime})\n`;
            report += `   • Pending Work: ${pendingTime}\n`;
            
            if (user.total_pending_minutes > 0) {
                report += `   ⚠️ *Has pending work*\n`;
            }
            report += `\n`;
        });

        return report;
    }

    // Generate user daily summary
    static formatUserDailySummary(userData, userName) {
        const leaveTime = this.formatDuration(userData.total_leave_minutes || 0);
        const extraWork = this.formatDuration(userData.total_extra_work_minutes || 0);
        const pending = this.formatDuration(userData.pending_extra_work_minutes || 0);
        const deadline = this.getDeadlineDate(7); // 7 days from now

        let summary = `📊 *Daily Summary for ${userName}*\n`;
        summary += `• Unplanned leave taken: ${leaveTime}\n`;
        summary += `• Extra work completed: ${extraWork}\n`;
        
        if (userData.pending_extra_work_minutes > 0) {
            summary += `• Extra work needed: ${pending}\n`;
            summary += `• Deadline: ${deadline}\n`;
            
            if (this.isDeadlineApproaching(this.getCurrentDate(), 7)) {
                summary += `⚠️ *Deadline approaching!*`;
            }
        } else {
            summary += `✅ *All caught up!*`;
        }

        return summary;
    }

    // Create leave transparency message
    static formatLeaveTransparencyMessage(userName, duration, reason, returnTime) {
        return `🏃‍♂️ *${userName}* is on unplanned leave for *${duration}* (${reason}) - back by *${returnTime}*`;
    }

    // Create leave end message
    static formatLeaveEndMessage(userName, actualDuration) {
        return `✅ *${userName}* returned from leave (actual time: *${actualDuration}*)`;
    }

    // Create half-day trigger message
    static formatHalfDayMessage(totalTime, formUrl) {
        return `⚠️ Your total unplanned leave today (${totalTime}) exceeds 2.5h. Please fill the half-day form: ${formUrl}`;
    }

    // Create extra work prompt message
    static formatExtraWorkPrompt(duration) {
        return `⏰ You've been working extra for ${duration}. Still working? React with ✅ to continue or ❌ to stop.`;
    }

    // Validate duration input
    static isValidDuration(durationStr) {
        const parsed = this.parseDuration(durationStr);
        return parsed > 0 && parsed <= 480; // Max 8 hours
    }

    // Get user mention format
    static getUserMention(userId) {
        return `<@${userId}>`;
    }

    // Get channel mention format
    static getChannelMention(channelId) {
        return `<#${channelId}>`;
    }

    // ================================
    // INTERACTIVE ADMIN DASHBOARD
    // ================================

    // Format main admin dashboard
    static formatAdminDashboard(liveStatus) {
        const { activeLeave, activeExtraWork, pendingWork, recentActivity } = liveStatus;
        
        // Quick stats
        const stats = [
            `🔴 Active Leave: ${activeLeave.length}`,
            `🟢 Active Work: ${activeExtraWork.length}`,
            `⚠️ Pending Work: ${pendingWork.length}`,
            `📊 Recent Activity: ${recentActivity.length}`
        ].join(' • ');

        return {
            text: `🎛️ *ADMIN DASHBOARD*\n\n${stats}\n\nUse the buttons below to explore:`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `🎛️ *ADMIN DASHBOARD*\n\n${stats}\n\nUse the buttons below to explore:`
                    }
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: { type: "plain_text", text: "🚨 Live Status" },
                            action_id: "admin_live_status",
                            style: "primary"
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "📊 Reports" },
                            action_id: "admin_reports"
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "👥 Users" },
                            action_id: "admin_users"
                        }
                    ]
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: { type: "plain_text", text: "📈 Analytics" },
                            action_id: "admin_analytics"
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "⚡ Actions" },
                            action_id: "admin_actions",
                            style: "danger"
                        }
                    ]
                }
            ]
        };
    }

    // Format live status view
    static formatLiveStatus(liveStatus) {
        const { activeLeave, activeExtraWork, pendingWork } = liveStatus;
        let text = "🚨 *LIVE STATUS DASHBOARD*\n\n";

        // Active Leave Sessions
        if (activeLeave.length > 0) {
            text += "🔴 *CURRENTLY ON LEAVE:*\n";
            activeLeave.forEach(session => {
                const plannedDuration = this.formatDuration(session.planned_duration);
                const currentDuration = Math.round((new Date() - new Date(session.start_time)) / (1000 * 60));
                const actualDuration = this.formatDuration(currentDuration);
                const exceeded = currentDuration > session.planned_duration;
                const status = exceeded ? `${actualDuration} ⚠️ *EXCEEDED*` : `${actualDuration}`;
                
                text += `• *${session.user_name}* (${session.reason}) - ${status}\n`;
            });
            text += "\n";
        }

        // Active Extra Work Sessions
        if (activeExtraWork.length > 0) {
            text += "🟢 *CURRENTLY WORKING EXTRA:*\n";
            activeExtraWork.forEach(session => {
                const currentDuration = Math.round((new Date() - new Date(session.start_time)) / (1000 * 60));
                const actualDuration = this.formatDuration(currentDuration);
                text += `• *${session.user_name}* - ${actualDuration} worked\n`;
            });
            text += "\n";
        }

        // Pending Work Alerts
        if (pendingWork.length > 0) {
            text += "⚠️ *PENDING WORK ALERTS:*\n";
            const grouped = {};
            pendingWork.forEach(item => {
                if (!grouped[item.user_name]) {
                    grouped[item.user_name] = { name: item.user_name, total: 0, days: 0 };
                }
                grouped[item.user_name].total += item.pending_extra_work_minutes;
                grouped[item.user_name].days++;
            });

            Object.values(grouped).forEach(user => {
                const totalPending = this.formatDuration(user.total);
                const daysText = user.days > 1 ? `${user.days} days` : '1 day';
                text += `• *${user.name}* - ${totalPending} pending (${daysText})\n`;
            });
            text += "\n";
        }

        if (activeLeave.length === 0 && activeExtraWork.length === 0 && pendingWork.length === 0) {
            text += "✅ *All quiet! No active sessions or pending work.*\n";
        }

        return {
            text,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text
                    }
                }
            ]
        };
    }

    // Format reports menu
    static getReportsMenu() {
        return [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "📊 *Select Report Type:*"
                }
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: { type: "plain_text", text: "📅 Weekly Report" },
                        action_id: "report_weekly",
                        style: "primary"
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "📆 Monthly Report" },
                        action_id: "report_monthly"
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "🎯 Custom Range" },
                        action_id: "report_custom"
                    }
                ]
            }
        ];
    }

    // Format users management view
    static formatUsersManagement(users) {
        let text = "👥 *USER MANAGEMENT*\n\n";
        
        if (users.length === 0) {
            text += "No users found.";
        } else {
            users.forEach((user, index) => {
                const pendingTime = this.formatDuration(user.total_pending || 0);
                const sessionsText = user.total_sessions || 0;
                const status = user.total_pending > 0 ? "⚠️" : "✅";
                
                text += `${index + 1}. ${status} *${user.name}*\n`;
                text += `   Sessions: ${sessionsText} • Pending: ${pendingTime}\n\n`;
            });
        }

        const blocks = [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text
                }
            }
        ];

        // Add user detail buttons
        if (users.length > 0) {
            const userButtons = users.slice(0, 5).map(user => ({
                type: "button",
                text: { 
                    type: "plain_text", 
                    text: `👤 ${user.name}` 
                },
                action_id: `user_details_${user.id}`
            }));

            blocks.push({
                type: "actions",
                elements: userButtons
            });
        }

        return { text, blocks };
    }

    // Format analytics view
    static formatAnalytics(analytics) {
        let text = "📈 *ANALYTICS DASHBOARD*\n\n";

        if (analytics.length === 0) {
            text += "No data available for analytics.";
        } else {
            const totalSessions = analytics.reduce((sum, day) => sum + day.daily_sessions, 0);
            const totalExceeded = analytics.reduce((sum, day) => sum + day.exceeded_sessions, 0);
            const avgDuration = analytics.reduce((sum, day) => sum + (day.avg_duration || 0), 0) / analytics.length;
            const maxDuration = Math.max(...analytics.map(day => day.max_duration || 0));
            const exceedRate = totalSessions > 0 ? ((totalExceeded / totalSessions) * 100).toFixed(1) : 0;

            text += `📊 *30-Day Summary:*\n`;
            text += `• Total Sessions: ${totalSessions}\n`;
            text += `• Avg Duration: ${this.formatDuration(Math.round(avgDuration))}\n`;
            text += `• Max Duration: ${this.formatDuration(maxDuration)}\n`;
            text += `• Exceed Rate: ${exceedRate}%\n\n`;

            text += `📈 *Recent Trends:*\n`;
            analytics.slice(0, 7).forEach(day => {
                const date = this.formatDate(day.date);
                const sessions = day.daily_sessions;
                const avgDur = this.formatDuration(Math.round(day.avg_duration || 0));
                const exceeded = day.exceeded_sessions;
                
                text += `• ${date}: ${sessions} sessions, avg ${avgDur}`;
                if (exceeded > 0) text += ` (${exceeded} exceeded)`;
                text += "\n";
            });
        }

        return {
            text,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text
                    }
                }
            ]
        };
    }

    // Format admin actions menu
    static getAdminActionsMenu() {
        return [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "⚡ *ADMIN ACTIONS*\n\nChoose an action to perform:"
                }
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: { type: "plain_text", text: "📧 Send Reminders" },
                        action_id: "action_send_reminders",
                        style: "primary"
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "🔄 Reset Pending" },
                        action_id: "action_reset_pending",
                        style: "danger"
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "✅ Approve Time" },
                        action_id: "action_approve_time"
                    }
                ]
            }
        ];
    }

    // Format user details view
    static formatUserDetails(userDetails) {
        const { user, recentSessions, summaries } = userDetails;
        
        let text = `👤 *USER DETAILS: ${user.name}*\n\n`;
        text += `📧 Email: ${user.email || 'Not provided'}\n`;
        text += `🆔 ID: ${user.id}\n\n`;

        // Recent Sessions
        if (recentSessions.length > 0) {
            text += `📋 *Recent Leave Sessions:*\n`;
            recentSessions.slice(0, 5).forEach(session => {
                const date = this.formatDate(session.date);
                const duration = session.actual_duration ? this.formatDuration(session.actual_duration) : 'Ongoing';
                const status = session.end_time ? '✅' : '🔴';
                
                text += `• ${status} ${date}: ${duration} (${session.reason})\n`;
            });
            text += "\n";
        }

        // Recent Summaries
        if (summaries.length > 0) {
            text += `📊 *Daily Summaries:*\n`;
            summaries.slice(0, 5).forEach(summary => {
                const date = this.formatDate(summary.date);
                const leave = this.formatDuration(summary.total_leave_minutes || 0);
                const work = this.formatDuration(summary.total_extra_work_minutes || 0);
                const pending = this.formatDuration(summary.pending_extra_work_minutes || 0);
                
                text += `• ${date}: Leave ${leave}, Work ${work}`;
                if (summary.pending_extra_work_minutes > 0) {
                    text += `, Pending ${pending}`;
                }
                text += "\n";
            });
        }

        return {
            text,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text
                    }
                }
            ]
        };
    }
}

module.exports = Utils; 