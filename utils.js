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
        return new Date().toISOString().split('T')[0];
    }

    // Get tomorrow's date in YYYY-MM-DD format
    static getTomorrowDate() {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
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

    // Generate comprehensive weekly report (shows ALL users including inactive)
    static formatComprehensiveWeeklyReport(allUsersData, startDate, endDate) {
        const totalUsers = allUsersData.length;
        const activeUsers = allUsersData.filter(u => u.leave_sessions_count > 0 || u.extra_work_sessions_count > 0);
        const usersWithPending = allUsersData.filter(u => u.total_pending_minutes > 0);
        const currentlyOnLeave = allUsersData.filter(u => u.current_status === 'ON_LEAVE');
        const currentlyWorking = allUsersData.filter(u => u.current_status === 'WORKING_EXTRA');
        
        // Calculate totals
        const totalLeaveMinutes = allUsersData.reduce((sum, user) => sum + user.total_leave_minutes, 0);
        const totalExtraWorkMinutes = allUsersData.reduce((sum, user) => sum + user.total_extra_work_minutes, 0);
        const totalPendingMinutes = allUsersData.reduce((sum, user) => sum + user.total_pending_minutes, 0);

        // Create text summary
        let text = `📊 *COMPREHENSIVE WEEKLY REPORT*\n`;
        text += `📅 Period: ${startDate} to ${endDate}\n\n`;
        text += `👥 *OVERVIEW:*\n`;
        text += `• Total Users: ${totalUsers}\n`;
        text += `• Active This Week: ${activeUsers.length}\n`;
        text += `• Currently on Leave: ${currentlyOnLeave.length}\n`;
        text += `• Currently Working Extra: ${currentlyWorking.length}\n`;
        text += `• Users with Pending Work: ${usersWithPending.length}\n\n`;
        text += `⏱️ *TIME SUMMARY:*\n`;
        text += `• Total Leave: ${this.formatDuration(totalLeaveMinutes)}\n`;
        text += `• Total Extra Work: ${this.formatDuration(totalExtraWorkMinutes)}\n`;
        text += `• Total Pending: ${this.formatDuration(totalPendingMinutes)}`;

        // Create blocks for better formatting
        const blocks = [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "📊 Weekly Report - All Users Review"
                }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `📅 *Period:* ${startDate} to ${endDate}`
                }
            },
            {
                type: "section",
                fields: [
                    {
                        type: "mrkdwn",
                        text: `👥 *Total Users:* ${totalUsers}`
                    },
                    {
                        type: "mrkdwn",
                        text: `✅ *Active This Week:* ${activeUsers.length}`
                    },
                    {
                        type: "mrkdwn",
                        text: `🔴 *Currently on Leave:* ${currentlyOnLeave.length}`
                    },
                    {
                        type: "mrkdwn",
                        text: `🟢 *Working Extra:* ${currentlyWorking.length}`
                    },
                    {
                        type: "mrkdwn",
                        text: `⚠️ *Pending Work:* ${usersWithPending.length}`
                    },
                    {
                        type: "mrkdwn",
                        text: `⏱️ *Total Pending:* ${this.formatDuration(totalPendingMinutes)}`
                    }
                ]
            },
            {
                type: "divider"
            }
        ];

        // Group users by status
        const usersByStatus = {
            'ON_LEAVE': currentlyOnLeave,
            'WORKING_EXTRA': currentlyWorking,
            'PENDING_WORK': usersWithPending.filter(u => u.current_status === 'AVAILABLE'),
            'ACTIVE_NO_PENDING': activeUsers.filter(u => u.total_pending_minutes === 0 && u.current_status === 'AVAILABLE'),
            'INACTIVE': allUsersData.filter(u => u.leave_sessions_count === 0 && u.extra_work_sessions_count === 0 && u.total_pending_minutes === 0)
        };

        // Add each status section
        Object.entries(usersByStatus).forEach(([status, users]) => {
            if (users.length === 0) return;

            let statusTitle = '';
            let statusEmoji = '';
            switch (status) {
                case 'ON_LEAVE':
                    statusTitle = 'Currently on Leave';
                    statusEmoji = '🔴';
                    break;
                case 'WORKING_EXTRA':
                    statusTitle = 'Currently Working Extra';
                    statusEmoji = '🟢';
                    break;
                case 'PENDING_WORK':
                    statusTitle = 'Users with Pending Work';
                    statusEmoji = '⚠️';
                    break;
                case 'ACTIVE_NO_PENDING':
                    statusTitle = 'Active Users (No Pending Work)';
                    statusEmoji = '✅';
                    break;
                case 'INACTIVE':
                    statusTitle = 'Inactive This Week';
                    statusEmoji = '⚪';
                    break;
            }

            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `${statusEmoji} *${statusTitle} (${users.length}):*`
                }
            });

            // Add user details for each status
            const userDetails = users.slice(0, 10).map(user => { // Limit to prevent message size issues
                const leaveTime = this.formatDuration(user.total_leave_minutes || 0);
                const extraWork = this.formatDuration(user.total_extra_work_minutes || 0);
                const pending = this.formatDuration(user.total_pending_minutes || 0);
                
                let userLine = `• *${user.name}*`;
                
                if (status === 'ON_LEAVE') {
                    userLine += ` - Currently on leave`;
                } else if (status === 'WORKING_EXTRA') {
                    userLine += ` - Working extra now`;
                } else if (status === 'PENDING_WORK') {
                    userLine += ` - Pending: ${pending}`;
                } else if (status === 'ACTIVE_NO_PENDING') {
                    userLine += ` - Leave: ${leaveTime}, Extra: ${extraWork}`;
                } else if (status === 'INACTIVE') {
                    userLine += ` - No activity this week`;
                }
                
                return userLine;
            }).join('\n');

            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: userDetails
                }
            });

            if (users.length > 10) {
                blocks.push({
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `_... and ${users.length - 10} more users_`
                        }
                    ]
                });
            }
        });

        // Add summary footer
        blocks.push(
            {
                type: "divider"
            },
            {
                type: "context",
                elements: [
                    {
                        type: "mrkdwn",
                        text: `📊 *Summary:* ${totalUsers} total users | ${this.formatDuration(totalLeaveMinutes)} leave | ${this.formatDuration(totalExtraWorkMinutes)} extra work | ${this.formatDuration(totalPendingMinutes)} pending`
                    }
                ]
            }
        );

        return { text, blocks };
    }

    // Generate comprehensive monthly report (same structure but different title)
    static formatComprehensiveMonthlyReport(allUsersData, startDate, endDate) {
        const report = this.formatComprehensiveWeeklyReport(allUsersData, startDate, endDate);
        
        // Update title and header for monthly report
        report.text = report.text.replace('COMPREHENSIVE WEEKLY REPORT', 'COMPREHENSIVE MONTHLY REPORT');
        report.blocks[0].text.text = "📊 Monthly Report - All Users Review";
        
        return report;
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
                    summary += `• Intermediate logout taken: ${leaveTime}\n`;
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
    static formatLeaveTransparencyMessage(userName, duration, reason, returnTime, taskEscalation = '') {
        let message = `🏃‍♂️ *${userName}* is on intermediate logout for *${duration}* (${reason}) - back by *${returnTime}*`;
        
        if (taskEscalation) {
            message += `\n\n🔄 *Task Escalation:* ${taskEscalation}`;
        }
        
        return message;
    }

    // Create planned leave transparency message
    static formatPlannedLeaveMessage(userName, leaveType, dateRange, daysDiff, reason, taskEscalation = '') {
        let message = `📅 *${userName}* has requested planned leave`;
        
        message += `\n• *Type:* ${this.formatLeaveType(leaveType)}`;
        message += `\n• *Dates:* ${dateRange}`;
        if (daysDiff > 1) {
            message += ` (${daysDiff} days)`;
        }
        message += `\n• *Reason:* ${reason}`;
        
        if (taskEscalation) {
            message += `\n\n🔄 *Task Escalation:* ${taskEscalation}`;
        }
        
        return message;
    }

    // Format leave type for display
    static formatLeaveType(leaveType) {
        const types = {
            'full_day': 'Full Day',
            'half_day_morning': 'Half Day (Morning)',
            'half_day_afternoon': 'Half Day (Afternoon)',
            'custom_hours': 'Custom Hours'
        };
        return types[leaveType] || 'Full Day';
    }

    // Format date for display (DD/MM/YYYY)
    static formatDate(dateStr) {
        const date = new Date(dateStr);
        return date.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
    }

    // Create leave end message
    static formatLeaveEndMessage(userName, actualDuration) {
        return `✅ *${userName}* returned from leave (actual time: *${actualDuration}*)`;
    }

    // Create time exceeded message (now considered half-day leave)
    static formatTimeExceededMessage(totalTime) {
        return `📝 *Time Summary*\n\nYour total time today (${totalTime}) exceeds the intermediate logout limit, so this has been processed as half-day leave.\n\nNo action needed - everything is properly recorded! 🌟`;
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
                    }
                ]
            }
        ];
    }

    // Format user details view
    static formatUserDetails(userDetails) {
        const { user, recentSessions, summaries } = userDetails;
        
        let text = `👤 *USER DETAILS: ${user.name}*\n\n`;

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

    // ================================
    // INTERACTIVE ADMIN MODALS
    // ================================

    // Create Live Status Modal
    static createLiveStatusModal(liveStatus) {
        const { activeLeave, activeExtraWork, pendingWork } = liveStatus;
        
        const blocks = [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "🚨 Live Status Dashboard"
                }
            },
            {
                type: "divider"
            }
        ];

        // Active Leave Sessions
        if (activeLeave.length > 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `🔴 *CURRENTLY ON LEAVE (${activeLeave.length}):*`
                }
            });
            
            activeLeave.forEach(session => {
                const plannedDuration = this.formatDuration(session.planned_duration);
                const currentDuration = Math.round((new Date() - new Date(session.start_time)) / (1000 * 60));
                const actualDuration = this.formatDuration(currentDuration);
                const exceeded = currentDuration > session.planned_duration;
                const status = exceeded ? `${actualDuration} ⚠️ *EXCEEDED*` : `${actualDuration}`;
                
                blocks.push({
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `👤 *${session.user_name}* • ${session.reason} • ${status}`
                        }
                    ]
                });
            });
        }

        // Active Extra Work Sessions
        if (activeExtraWork.length > 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `🟢 *CURRENTLY WORKING EXTRA (${activeExtraWork.length}):*`
                }
            });
            
            activeExtraWork.forEach(session => {
                const currentDuration = Math.round((new Date() - new Date(session.start_time)) / (1000 * 60));
                const actualDuration = this.formatDuration(currentDuration);
                
                blocks.push({
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `👤 *${session.user_name}* • ${actualDuration} worked`
                        }
                    ]
                });
            });
        }

        // Pending Work Alerts
        if (pendingWork.length > 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `⚠️ *PENDING WORK ALERTS (${pendingWork.length}):*`
                }
            });
            
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
                
                blocks.push({
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `👤 *${user.name}* • ${totalPending} pending (${daysText})`
                        }
                    ]
                });
            });
        }

        // All clear message
        if (activeLeave.length === 0 && activeExtraWork.length === 0 && pendingWork.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "✅ *All quiet! No active sessions or pending work.*"
                }
            });
        }

        return {
            type: 'modal',
            title: { type: 'plain_text', text: 'Live Status' },
            close: { type: 'plain_text', text: 'Close' },
            blocks
        };
    }

    // Create Reports Modal
    static createReportsModal() {
        return {
            type: 'modal',
            title: { type: 'plain_text', text: 'Admin Reports' },
            close: { type: 'plain_text', text: 'Close' },
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "📊 Generate Reports"
                    }
                },
                {
                    type: "divider"
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "Select the type of report you'd like to generate:"
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
                        }
                    ]
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: "💡 Reports include leave sessions, extra work, and pending tasks"
                        }
                    ]
                }
            ]
        };
    }

    // Create Analytics Modal
    static createAnalyticsModal(analytics) {
        const blocks = [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "📈 Analytics Dashboard"
                }
            },
            {
                type: "divider"
            }
        ];

        if (analytics.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "📊 No data available for analytics."
                }
            });
        } else {
            const totalSessions = analytics.reduce((sum, day) => sum + day.daily_sessions, 0);
            const totalExceeded = analytics.reduce((sum, day) => sum + day.exceeded_sessions, 0);
            const avgDuration = analytics.reduce((sum, day) => sum + (day.avg_duration || 0), 0) / analytics.length;
            const maxDuration = Math.max(...analytics.map(day => day.max_duration || 0));
            const exceedRate = totalSessions > 0 ? ((totalExceeded / totalSessions) * 100).toFixed(1) : 0;

            // Summary Section
            blocks.push({
                type: "section",
                fields: [
                    {
                        type: "mrkdwn",
                        text: `*📊 Total Sessions:*\n${totalSessions}`
                    },
                    {
                        type: "mrkdwn",
                        text: `*⏰ Avg Duration:*\n${this.formatDuration(Math.round(avgDuration))}`
                    },
                    {
                        type: "mrkdwn",
                        text: `*🔥 Max Duration:*\n${this.formatDuration(maxDuration)}`
                    },
                    {
                        type: "mrkdwn",
                        text: `*⚠️ Exceed Rate:*\n${exceedRate}%`
                    }
                ]
            });

            blocks.push({
                type: "divider"
            });

            // Recent Trends
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "*📈 Recent Trends (Last 7 Days):*"
                }
            });

            analytics.slice(0, 7).forEach(day => {
                const date = this.formatDate(day.date);
                const sessions = day.daily_sessions;
                const avgDur = this.formatDuration(Math.round(day.avg_duration || 0));
                const exceeded = day.exceeded_sessions;
                
                let trendText = `*${date}:* ${sessions} sessions, avg ${avgDur}`;
                if (exceeded > 0) trendText += ` (${exceeded} exceeded)`;
                
                blocks.push({
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: trendText
                        }
                    ]
                });
            });
        }

        return {
            type: 'modal',
            title: { type: 'plain_text', text: 'Analytics' },
            close: { type: 'plain_text', text: 'Close' },
            blocks
        };
    }
}

module.exports = Utils; 