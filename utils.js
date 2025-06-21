const moment = require('moment');

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
        const now = moment();
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
        return moment().format('YYYY-MM-DD');
    }

    // Get current time in ISO format
    static getCurrentTime() {
        return moment().toISOString();
    }

    // Format time for display
    static formatTime(timestamp) {
        return moment(timestamp).format('h:mm A');
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
        let report = `📈 **ADMIN REPORT** (${startDate} to ${endDate})\n`;
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

        report += `**SUMMARY:**\n`;
        report += `• Total Users: ${totalUsers}\n`;
        report += `• Total Leave Time: ${this.formatDuration(totalLeaveMinutes)}\n`;
        report += `• Total Extra Work Time: ${this.formatDuration(totalExtraWorkMinutes)}\n`;
        report += `• Total Pending Time: ${this.formatDuration(totalPendingMinutes)}\n\n`;

        report += `**USER DETAILS:**\n`;
        report += `${'─'.repeat(80)}\n`;

        data.forEach((user, index) => {
            const leaveTime = this.formatDuration(user.total_leave_minutes || 0);
            const extraWorkTime = this.formatDuration(user.total_extra_work_minutes || 0);
            const pendingTime = this.formatDuration(user.total_pending_minutes || 0);
            
            report += `${index + 1}. **${user.name}**\n`;
            report += `   • Leave Sessions: ${user.total_leave_sessions} (${leaveTime})\n`;
            report += `   • Extra Work Sessions: ${user.total_extra_work_sessions} (${extraWorkTime})\n`;
            report += `   • Pending Work: ${pendingTime}\n`;
            
            if (user.total_pending_minutes > 0) {
                report += `   ⚠️ **Has pending work**\n`;
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

        let summary = `📊 **Daily Summary for ${userName}**\n`;
        summary += `• Unplanned leave taken: ${leaveTime}\n`;
        summary += `• Extra work completed: ${extraWork}\n`;
        
        if (userData.pending_extra_work_minutes > 0) {
            summary += `• Extra work needed: ${pending}\n`;
            summary += `• Deadline: ${deadline}\n`;
            
            if (this.isDeadlineApproaching(this.getCurrentDate(), 7)) {
                summary += `⚠️ **Deadline approaching!**`;
            }
        } else {
            summary += `✅ **All caught up!**`;
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
}

module.exports = Utils; 