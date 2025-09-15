# External Monitoring Setup for Render Free Tier

## Problem
Render's free tier can still spin down services even with internal keepalive pings. This document provides external monitoring solutions.

## Solution 1: UptimeRobot (Recommended - Free)

### Setup:
1. Visit [uptimerobot.com](https://uptimerobot.com) 
2. Create a free account (monitors up to 50 websites)
3. Add a new monitor:
   - **Monitor Type**: HTTP(s)
   - **URL**: `https://attendance-bot-1dr6.onrender.com/ping`
   - **Friendly Name**: `Attendance Bot - Ping`
   - **Monitoring Interval**: 5 minutes
   - **Alert Contacts**: Your email

4. Add a second monitor for the health endpoint:
   - **URL**: `https://attendance-bot-1dr6.onrender.com/health`
   - **Friendly Name**: `Attendance Bot - Health`
   - **Monitoring Interval**: 10 minutes

### Benefits:
- ✅ Free external monitoring
- ✅ Email alerts when service goes down
- ✅ Automatic pinging every 5 minutes
- ✅ Uptime statistics and reporting

## Solution 2: Cronitor (Alternative)

### Setup:
1. Visit [cronitor.io](https://cronitor.io)
2. Create free account
3. Add HTTP monitor for your service
4. Set check interval to 5 minutes

## Solution 3: Self-hosted monitoring (Advanced)

If you have another server or use GitHub Actions:

```yaml
# .github/workflows/monitor.yml
name: Keep Render Service Alive
on:
  schedule:
    - cron: '*/4 * * * *'  # Every 4 minutes
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping service
        run: |
          curl -f https://attendance-bot-1dr6.onrender.com/ping || exit 1
```

## Current Internal Monitoring

The bot now includes:
- **Primary keepalive**: Every 5 minutes
- **Business hours monitoring**: Every 3 minutes (9 AM - 6 PM IST)
- **Health checks**: Every 15 minutes
- **Bot responsiveness monitoring**: Every 20 minutes
- **Auto-recovery**: Attempts to reconnect Socket Mode if issues detected

## Recommended Approach

1. **Set up UptimeRobot** (external monitoring)
2. **Keep internal monitoring** (current implementation)
3. **Monitor logs** for health check messages
4. **Consider upgrading to Render paid tier** ($7/month) for guaranteed uptime

## Log Messages to Watch For

✅ **Good signs:**
- `🔄 Keepalive ping successful`
- `💓 Bot health: Active`
- `✅ Health check passed`

⚠️ **Warning signs:**
- `⚠️ Bot may be unresponsive`
- `🐌 Slow response detected`
- `❌ Keepalive ping failed`

🚨 **Critical signs:**
- `🚨 Health check failed`
- `🚨 Keepalive failed X times consecutively`
- `❌ Socket Mode reconnection failed`
