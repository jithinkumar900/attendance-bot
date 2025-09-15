# Self-Healing System Documentation

## Overview

The Attendance Bot now includes a comprehensive self-healing system that automatically recovers from service interruptions while preserving all data integrity. This system ensures zero data loss even when Render's free tier spins down the service.

## 🛡️ Data Preservation Guarantee

### Database Persistence
- **SQLite database** (`attendance.db`) persists on Render's disk storage
- **All leave requests, sessions, and user data** survive service restarts
- **Automatic database integrity checks** on startup and during healing
- **Safe database reconnection** with proper connection handling

### Critical Data Protected
- ✅ Pending leave requests (intermediate, planned, early logout, late login)
- ✅ Active leave sessions (intermediate logout in progress)
- ✅ User work balances and pending work time
- ✅ Daily summaries and historical data
- ✅ Approval workflow state and timestamps

## 🔧 Self-Healing Mechanisms

### 1. Automatic Detection
- **Unresponsiveness monitoring**: Triggers healing if no Slack activity for 45+ minutes
- **Critical failure threshold**: Activates healing after 5 consecutive failures
- **Health check failures**: Monitored every 10 minutes
- **Socket Mode disconnections**: Automatic reconnection attempts

### 2. Healing Process (6-Step Recovery)

#### Step 1: Database Integrity Check
```sql
-- Verifies core tables are accessible
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM leave_requests WHERE status = 'pending';
```

#### Step 2: Slack Connectivity Test
```javascript
await app.client.auth.test();
```

#### Step 3: Socket Mode Reconnection
- Graceful disconnect → 3-second wait → reconnect
- Continues even if Socket Mode fails (fallback to polling)

#### Step 4: Service Endpoint Verification
- Tests `/ping` and `/health` endpoints
- Confirms service is responding to external requests

#### Step 5: Application State Recovery
- Recovers pending leave requests
- Identifies active leave sessions
- Logs overtime sessions for admin attention

#### Step 6: Health Indicator Reset
- Resets failure counters
- Updates activity timestamps
- Marks bot as healthy

### 3. Aggressive Recovery (Last Resort)
When standard healing fails 3+ times:
- **Database reconnection**: Safely closes and reopens database
- **App restart**: Reinitializes Slack connection
- **Full state recovery**: Rebuilds application state from database

## 🚨 Startup Recovery Process

Every time the service starts (including after Render spin-down):

### Data Recovery
1. **Database integrity verification**
2. **Pending request recovery** - Logs all pending approvals
3. **Active session recovery** - Identifies ongoing leaves
4. **Overtime session handling** - Auto-converts sessions that exceeded limits during downtime

### Urgent Issue Detection
- **Overtime sessions**: Auto-converts to half-day leave with HR notification
- **Stale requests**: Flags leave requests older than 24 hours
- **Data consistency**: Ensures no orphaned records

## 📊 Monitoring & Alerting

### Log Messages to Monitor

✅ **Healthy Operation:**
```
🔄 Starting startup recovery process...
✅ Database integrity verified
📋 Found X pending leave requests in database
✅ Startup recovery completed successfully
```

⚠️ **Warning Signs:**
```
🚨 Bot unresponsive for X minutes, triggering self-healing...
🔧 Starting self-healing attempt X/3
🚨 Found X overtime sessions during startup
```

🚨 **Critical Issues:**
```
❌ Database integrity check failed
🚨 Max healing attempts (3) reached, manual intervention required
🚨 CRITICAL: Manual intervention required - service may need restart
```

### Health Monitoring Schedule
- **Primary keepalive**: Every 5 minutes
- **Health checks**: Every 15 minutes
- **Self-healing triggers**: Every 10 minutes
- **Business hours monitoring**: Every 3 minutes (9 AM - 6 PM IST)

## 🔄 Recovery Scenarios

### Scenario 1: Render Free Tier Spin-Down
**What happens:**
- Service goes to sleep after 15 minutes of inactivity
- Database file remains intact on disk
- All pending requests and sessions preserved

**Recovery process:**
1. External monitoring (UptimeRobot) detects downtime
2. Ping request wakes up service
3. Startup recovery automatically runs
4. All data is recovered and processed
5. Overtime sessions auto-converted if needed

### Scenario 2: Network/Connection Issues
**What happens:**
- Socket Mode connection drops
- Bot appears unresponsive but service is running

**Recovery process:**
1. Health monitoring detects unresponsiveness
2. Self-healing automatically triggered
3. Socket Mode reconnection attempted
4. Service continues with minimal disruption

### Scenario 3: Database Lock/Corruption
**What happens:**
- Database operations fail
- Data integrity compromised

**Recovery process:**
1. Database integrity check fails
2. Aggressive recovery initiated
3. Safe database reconnection
4. State verification and recovery

## 🛠️ Administrative Features

### Manual Healing Trigger
Admins can manually trigger healing by checking logs for specific patterns or using admin commands (future feature).

### Data Recovery Reports
Startup generates comprehensive recovery reports:
- Number of pending requests recovered
- Active sessions identified
- Overtime conversions performed
- Data integrity status

### Failure Analysis
- Healing attempt tracking with cooldown periods
- Critical failure counting and escalation
- Detailed error logging for troubleshooting

## 🎯 Best Practices

### For Administrators
1. **Monitor startup logs** after any service restart
2. **Check for auto-conversion notifications** in leave-approval channel
3. **Review stale requests** flagged during recovery
4. **Set up external monitoring** (UptimeRobot) for early detection

### For Users
- **No action required** - all data is automatically preserved
- **Requests remain valid** even during service downtime
- **Active sessions continue** where they left off after recovery

## 🔮 Future Enhancements

### Planned Improvements
- **Manual healing API endpoint** for admin-triggered recovery
- **Enhanced recovery notifications** to inform users of data preservation
- **Backup/restore functionality** for critical data snapshots
- **Recovery metrics dashboard** for monitoring system health

### Integration Options
- **Webhook notifications** for critical failures
- **Slack admin alerts** for healing events
- **Database backup to cloud storage** for additional safety

## 📈 Success Metrics

The self-healing system is successful when:
- ✅ **Zero data loss** during service interruptions
- ✅ **Automatic recovery** without manual intervention
- ✅ **Seamless user experience** despite infrastructure limitations
- ✅ **Complete audit trail** of all healing activities

---

This self-healing system ensures that even with Render's free tier limitations, your attendance bot maintains 100% data integrity and provides a reliable service experience for all users.
