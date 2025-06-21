# Attendance Bot 🤖

A comprehensive Slack bot for tracking unplanned leave and managing extra work hours with full transparency and automated notifications.

## ✨ Features

### 🚪 Leave Tracking
- **Transparent Reporting**: All leave is posted to a public channel for company-wide visibility
- **Smart Time Calculation**: Automatically tracks actual vs. planned leave duration
- **Half-day Integration**: Auto-triggers Google Form when leave exceeds 2.5 hours
- **Real-time Updates**: Shows expected return time and actual duration

### ⏰ Extra Work Management
- **Automatic Prompts**: Hourly check-ins during extra work sessions
- **Smart Calculations**: Automatically calculates required extra work based on leave taken
- **Deadline Tracking**: 7-day deadline with automated reminders
- **Flexible Scheduling**: Work extra hours any day to compensate

### 📊 Reporting & Analytics
- **Daily Summaries**: End-of-day reports for each user
- **Admin Dashboard**: Comprehensive reports with password protection
- **Weekly Reminders**: Automated alerts for pending extra work
- **User Balance**: Check current leave/work balance anytime

### 🔧 Dynamic Configuration
- **No Hard-coding**: All settings in `config.json`
- **Customizable Messages**: Personalize all bot communications
- **Flexible Notifications**: Configure who gets notified and where
- **Easy Deployment**: Plug-and-play setup

## 🚀 Quick Start

### 1. Prerequisites
- Node.js 16+
- Slack workspace admin access
- Google Form (optional, for half-day leave)

### 2. Installation

```bash
# Clone or download the project
git clone <your-repo> attendance-bot
cd attendance-bot

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
```

### 3. Slack App Setup

1. **Create Slack App**: Go to [api.slack.com/apps](https://api.slack.com/apps)
2. **Enable Socket Mode**: 
   - Go to Socket Mode → Enable Socket Mode
   - Generate App-Level Token with `connections:write` scope
3. **Bot Token Scopes**: Add these scopes:
   - `chat:write`
   - `users:read`
   - `channels:read`
   - `app_mentions:read`
   - `commands`
4. **Slash Commands**: Create these commands:
   - `/unplanned`
   - `/return`
   - `/work-start`
   - `/work-end`
   - `/review`
   - `/admin`

### 4. Configuration

#### Update `.env`:
```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
```

#### Update `config.json`:
```json
{
  "bot": {
    "maxUnplannedHours": 2.5,
    "adminPassword": "your-secure-password",
    "transparencyChannel": "#unplanned-leave",
    "halfDayFormUrl": "https://forms.google.com/your-form"
  },
  "notifications": {
    "notifyUsers": ["@hr-team", "@manager"],
    "notifyChannels": ["#hr-notifications"]
  }
}
```

### 5. Run the Bot

```bash
# Development
npm run dev

# Production
npm start
```

## 📝 Usage Guide

### For Employees

#### Starting Unplanned Leave
```
/unplanned 1.5h doctor appointment
/unplanned 30m bank work
/unplanned 2h personal work
```

#### Ending Leave
```
/return
```

#### Managing Extra Work
```
/work-start
/work-start Working on project X
/work-end
```

#### Check Balance
```
/review
```

### For Admins

#### Generate Reports
```
/admin your-password
```

## 🔄 Automated Workflows

### Daily Flow
1. **Leave Start**: Employee uses `/unplanned 1h dentist`
2. **Public Notification**: "John is on leave for 1h (dentist) - back by 2:30 PM"
3. **Leave End**: Employee uses `/return` or auto-detected
4. **Time Check**: If total > 2.5h → Half-day form sent
5. **End of Day**: Summary sent: "You need 0.5h extra work (7 days to complete)"

### Extra Work Flow
1. **Start**: Employee uses `/work-start`
2. **Hourly Prompts**: "Still working? ✅ Continue or ❌ Stop"
3. **Auto-end**: When user clicks Stop or uses `/work-end`
4. **Balance Update**: Pending extra work reduced automatically

### Weekly Reminders
- **Monday 9 AM**: Reminds users with pending extra work
- **Deadline Alerts**: Warning when 7-day deadline approaches

## 📊 Data Structure

### Database Tables
- **users**: Employee information
- **leave_sessions**: All leave records with timestamps
- **extra_work_sessions**: Extra work tracking
- **daily_summaries**: Aggregated daily data

### Key Metrics Tracked
- Total leave time vs. planned leave time
- Extra work completed vs. required
- Pending extra work by user
- Half-day triggers and completions

## 🛠️ Advanced Configuration

### Custom Messages
Edit `config.json` to customize all bot messages:
```json
{
  "messages": {
    "leaveStarted": "🏃‍♂️ **{user}** is on leave for **{duration}** ({reason})",
    "dailySummary": "📊 Your summary: {leaveTime} leave, {extraWork} needed"
  }
}
```

### Notification Channels
```json
{
  "notifications": {
    "notifyUsers": ["@hr", "@john.manager"],
    "notifyChannels": ["#attendance", "#management"]
  }
}
```

### Time Settings
```json
{
  "bot": {
    "maxUnplannedHours": 2.5,
    "workingHoursPerDay": 8,
    "extraWorkDeadlineDays": 7
  }
}
```

## 🔐 Security Features

- **Admin Password Protection**: Secure admin reports
- **User Validation**: Only registered Slack users can interact
- **Data Encryption**: SQLite database with safe queries
- **Rate Limiting**: Built-in Slack rate limiting

## 📈 Reporting Features

### Admin Reports Include:
- Total users and activity
- Leave patterns and trends
- Extra work completion rates
- Users with pending work
- Company-wide statistics

### User Reports Include:
- Daily leave/work balance
- Pending extra work hours
- Deadline information
- Historical data

## 🚨 Troubleshooting

### Common Issues

**Bot not responding:**
```bash
# Check environment variables
echo $SLACK_BOT_TOKEN

# Verify database
ls -la attendance.db

# Check logs
npm run dev
```

**Commands not working:**
- Verify slash commands are created in Slack app settings
- Check bot has proper permissions in channels
- Ensure Socket Mode is enabled

**Database errors:**
```bash
# Reset database (WARNING: loses all data)
rm attendance.db
npm start
```

## 🔄 Updates & Maintenance

### Regular Tasks
- **Weekly**: Review admin reports
- **Monthly**: Backup database file
- **Quarterly**: Update dependencies

### Database Backup
```bash
# Backup
cp attendance.db attendance_backup_$(date +%Y%m%d).db

# Restore
cp attendance_backup_20240101.db attendance.db
```

## 📞 Support

### Need Help?
1. Check this README
2. Review `config.json` settings
3. Check Slack app permissions
4. Verify environment variables

### Feature Requests
- Add new slash commands in `app.js`
- Modify messages in `config.json`
- Extend database schema in `database.js`

## 📄 License

MIT License - Feel free to customize for your organization!

---

**Made with ❤️ for better workplace transparency and accountability** 