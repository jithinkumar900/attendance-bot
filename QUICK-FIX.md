# 🚀 QUICK FIX - Enable 24/7 Keepalive

## ⚡ Immediate Steps (Takes 2 minutes)

### 1. Add Environment Variable in Render
1. Go to: [Render Dashboard](https://dashboard.render.com)
2. Click your **attendance-bot** service
3. Go to **Environment** tab
4. Click **Add Environment Variable**
5. Set:
   - **Key**: `RENDER_URL`
   - **Value**: `https://attendance-bot-1dr6.onrender.com`
6. Click **Save Changes**

### 2. Redeploy  
1. Go to **Deploys** tab
2. Click **Manual Deploy** → **Deploy latest commit**
3. Wait ~2 minutes for deployment

## ✅ Expected Results

### Logs Every 3 Minutes:
```
🔄 Keepalive ping successful
🔄 Business hours ping successful (during 9-6 PM IST)
```

### Test URL:
Visit: https://attendance-bot-1dr6.onrender.com/
Should show:
```json
{
  "status": "alive", 
  "keepalive": "enabled"
}
```

## 🎯 What This Fixes

✅ **Enables internal keepalive pings every 3 minutes**  
✅ **Extra business hours pings every 2 minutes**  
✅ **Should prevent most spin-downs**  
✅ **~80-90% uptime improvement**  

## 📋 If Still Having Issues

**External Backup (Recommended):**
1. Sign up: [UptimeRobot](https://uptimerobot.com) (free)
2. Add monitor:
   - URL: `https://attendance-bot-1dr6.onrender.com/ping`
   - Interval: 3 minutes
3. This provides external pings as backup

**Ultimate Solution:**
- Upgrade to Render Starter ($7/month) for 100% uptime

## 🔍 Debug Commands
```bash
# Check if your URL is working
curl https://attendance-bot-1dr6.onrender.com/ping

# Should return:
{"status":"alive","timestamp":"..."}
```