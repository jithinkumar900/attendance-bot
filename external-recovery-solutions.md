# External Recovery Solutions for Complete Service Spin-Down

## Problem Statement

When Render's free tier completely spins down the service, the bot's internal self-deployment logic cannot run because the process is not active. We need **external monitoring** that can trigger deployment when the service is completely offline.

## 🎯 Solution 1: UptimeRobot with Deploy Hook (Recommended)

### Setup UptimeRobot Monitor
1. **Create account**: https://uptimerobot.com (free tier: 50 monitors)
2. **Add HTTP monitor**:
   - **URL**: `https://attendance-bot-1dr6.onrender.com/ping`
   - **Monitor Type**: HTTP(s)
   - **Monitoring Interval**: 5 minutes
   - **Request Timeout**: 30 seconds

### Configure Auto-Recovery Webhook
3. **Add Alert Contact**:
   - **Type**: Webhook
   - **URL**: `https://api.render.com/deploy/srv-d1bbts3e5dus73ef83dg?key=7LEZ9PURBMo`
   - **HTTP Method**: POST
   - **Send Alerts When**: Down
   - **Alert Message**: (leave default)

### How It Works:
- UptimeRobot pings your service every 5 minutes
- If service is down (spin-down), it immediately triggers the deploy hook
- Render receives deploy signal and spins up fresh instance
- Service comes back online automatically

## 🎯 Solution 2: GitHub Actions Monitoring

### Create `.github/workflows/monitor.yml`:
```yaml
name: Attendance Bot Monitor
on:
  schedule:
    - cron: '*/5 * * * *'  # Every 5 minutes
  workflow_dispatch:  # Allow manual trigger

jobs:
  check-and-recover:
    runs-on: ubuntu-latest
    steps:
      - name: Check Service Health
        id: health-check
        run: |
          response=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 \
            "https://attendance-bot-1dr6.onrender.com/ping" || echo "000")
          echo "HTTP_CODE=$response" >> $GITHUB_OUTPUT
          
          if [ "$response" != "200" ]; then
            echo "Service is down (HTTP $response), triggering deployment..."
            echo "NEEDS_DEPLOY=true" >> $GITHUB_OUTPUT
          else
            echo "Service is healthy (HTTP $response)"
            echo "NEEDS_DEPLOY=false" >> $GITHUB_OUTPUT
          fi

      - name: Trigger Render Deployment
        if: steps.health-check.outputs.NEEDS_DEPLOY == 'true'
        run: |
          deploy_response=$(curl -s -X POST \
            "${{ secrets.RENDER_DEPLOY_HOOK }}" \
            -H "Content-Type: application/json")
          
          echo "Deploy triggered: $deploy_response"
          
          # Optional: Send notification
          curl -X POST "${{ secrets.SLACK_WEBHOOK_URL }}" \
            -H "Content-Type: application/json" \
            -d '{
              "text": "🚀 Attendance bot was offline and has been automatically redeployed via GitHub Actions"
            }' || true

      - name: Wait and Verify Recovery
        if: steps.health-check.outputs.NEEDS_DEPLOY == 'true'
        run: |
          echo "Waiting 3 minutes for deployment to complete..."
          sleep 180
          
          recovery_response=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 \
            "https://attendance-bot-1dr6.onrender.com/ping" || echo "000")
          
          if [ "$recovery_response" = "200" ]; then
            echo "✅ Recovery successful! Service is back online."
          else
            echo "❌ Recovery failed. Service still returning HTTP $recovery_response"
            exit 1
          fi
```

### Setup GitHub Secrets:
1. Go to your repo → **Settings** → **Secrets and Variables** → **Actions**
2. Add secrets:
   - `RENDER_DEPLOY_HOOK`: `https://api.render.com/deploy/srv-d1bbts3e5dus73ef83dg?key=7LEZ9PURBMo`
   - `SLACK_WEBHOOK_URL`: (optional, for notifications)

## 🎯 Solution 3: Zapier/IFTTT Automation

### Zapier Setup:
1. **Trigger**: Webhook by Zapier (scheduled every 5 minutes)
2. **Action 1**: GET request to `https://attendance-bot-1dr6.onrender.com/ping`
3. **Filter**: Only continue if response is not 200
4. **Action 2**: POST request to deploy hook
5. **Action 3**: Send notification (optional)

### IFTTT Alternative:
- Less flexible but simpler setup
- Use "Date & Time" trigger with webhook action

## 🎯 Solution 4: External Monitoring Script

### Simple Bash Script (run on any server):
```bash
#!/bin/bash
# attendance-bot-monitor.sh

SERVICE_URL="https://attendance-bot-1dr6.onrender.com/ping"
DEPLOY_HOOK="https://api.render.com/deploy/srv-d1bbts3e5dus73ef83dg?key=7LEZ9PURBMo"
LOG_FILE="/var/log/attendance-bot-monitor.log"

check_and_recover() {
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Check service health
    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "$SERVICE_URL" || echo "000")
    
    if [ "$http_code" = "200" ]; then
        echo "[$timestamp] ✅ Service healthy (HTTP $http_code)" >> "$LOG_FILE"
        return 0
    else
        echo "[$timestamp] 🚨 Service down (HTTP $http_code), triggering deployment..." >> "$LOG_FILE"
        
        # Trigger deployment
        deploy_response=$(curl -s -X POST "$DEPLOY_HOOK" -H "Content-Type: application/json")
        echo "[$timestamp] 🚀 Deploy triggered: $deploy_response" >> "$LOG_FILE"
        
        # Wait and verify
        sleep 180
        recovery_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "$SERVICE_URL" || echo "000")
        
        if [ "$recovery_code" = "200" ]; then
            echo "[$timestamp] ✅ Recovery successful!" >> "$LOG_FILE"
        else
            echo "[$timestamp] ❌ Recovery failed (HTTP $recovery_code)" >> "$LOG_FILE"
        fi
    fi
}

# Run the check
check_and_recover
```

### Cron Setup:
```bash
# Add to crontab (crontab -e)
*/5 * * * * /path/to/attendance-bot-monitor.sh
```

## 🎯 Solution 5: Cloudflare Workers (Advanced)

### Worker Script:
```javascript
export default {
  async scheduled(event, env, ctx) {
    const serviceUrl = 'https://attendance-bot-1dr6.onrender.com/ping';
    const deployHook = env.RENDER_DEPLOY_HOOK;
    
    try {
      const response = await fetch(serviceUrl, { 
        method: 'GET',
        timeout: 30000 
      });
      
      if (!response.ok) {
        console.log(`Service down (${response.status}), triggering deployment...`);
        
        await fetch(deployHook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('Deployment triggered via Cloudflare Worker');
      }
    } catch (error) {
      console.log(`Service unreachable: ${error.message}, triggering deployment...`);
      
      await fetch(deployHook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
```

## 📊 Comparison of Solutions

| Solution | Setup Difficulty | Reliability | Cost | Response Time |
|----------|------------------|-------------|------|---------------|
| UptimeRobot | ⭐⭐ Easy | ⭐⭐⭐⭐⭐ High | Free | 5 minutes |
| GitHub Actions | ⭐⭐⭐ Medium | ⭐⭐⭐⭐ High | Free | 5 minutes |
| Zapier | ⭐⭐ Easy | ⭐⭐⭐ Medium | $20/month | 5-15 minutes |
| External Script | ⭐⭐⭐⭐ Hard | ⭐⭐⭐⭐⭐ High | Server cost | 1-5 minutes |
| Cloudflare Workers | ⭐⭐⭐⭐ Hard | ⭐⭐⭐⭐⭐ High | $5/month | 1 minute |

## 🎯 Recommended Implementation

### **Primary: UptimeRobot** (Easiest, Most Reliable)
- Set up webhook to deploy hook
- 5-minute monitoring interval
- Instant deployment trigger on failure
- Free tier sufficient for this use case

### **Backup: GitHub Actions** (Free, Repository-based)
- Runs on GitHub's infrastructure
- Version controlled monitoring
- Can include recovery verification
- Slack notifications included

## 🔧 Testing Your External Monitor

### Test Service Down Scenario:
1. **Manually trigger deployment**: Use the deploy hook directly
2. **Watch monitoring logs**: Check if external monitor detects the restart
3. **Verify recovery**: Ensure service comes back online
4. **Check notifications**: Confirm alerts are working

### Test Commands:
```bash
# Test deploy hook manually
curl -X POST "https://api.render.com/deploy/srv-d1bbts3e5dus73ef83dg?key=7LEZ9PURBMo"

# Check service status
curl -s "https://attendance-bot-1dr6.onrender.com/ping" | jq .

# Monitor uptime after deployment
watch -n 10 'curl -s -o /dev/null -w "HTTP %{http_code} - Response time: %{time_total}s\n" "https://attendance-bot-1dr6.onrender.com/ping"'
```

## 🎉 Complete Protection Strategy

### **Layer 1**: Internal Self-Healing (when service is running)
- Database issues, Slack connection problems
- Memory leaks, performance degradation

### **Layer 2**: External Monitoring (when service is completely down)
- UptimeRobot webhook deployment
- GitHub Actions recovery automation

### **Layer 3**: Manual Failsafe
- Admin access to deploy hook
- Render dashboard manual deployment

This creates **true 24/7 availability** with automatic recovery from ANY failure scenario!
