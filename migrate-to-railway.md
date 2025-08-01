# 🚄 Migrate to Railway.app (Free Tier)

## Why Railway.app?
- ✅ **500 execution hours/month FREE** (vs Render's 15-min idle limit)
- ✅ **No automatic sleep** - stays alive much longer
- ✅ **Easy migration** - similar to Render
- ✅ **Built-in environment variables**
- ✅ **Automatic deployments from GitHub**

## Migration Steps

### 1. Sign Up & Connect GitHub
```bash
# Visit railway.app and sign up with GitHub
# Connect your attendance-bot repository
```

### 2. Install Railway CLI
```bash
npm install -g @railway/cli
railway login
```

### 3. Deploy Your Bot
```bash
# In your project directory
railway init
railway up
```

### 4. Set Environment Variables
```bash
# Set all your Slack tokens
railway variables set SLACK_BOT_TOKEN=xoxb-your-token
railway variables set SLACK_APP_TOKEN=xapp-your-token
railway variables set SLACK_SIGNING_SECRET=your-secret

# Set other variables
railway variables set MAX_INTERMEDIATE_HOURS=2.5
railway variables set TRANSPARENCY_CHANNEL=#intermediate-logout
railway variables set LEAVE_APPROVAL_CHANNEL=#leave-approval
railway variables set HR_TAG=@U123456789
railway variables set LEAVE_APPROVAL_TAG=@U987654321
railway variables set ADMIN_PASSWORD=your-password

# Set Railway URL for keepalive (will be provided after deployment)
railway variables set RENDER_URL=https://your-app.railway.app
```

### 5. Update Slack App Settings
- Go to Slack App settings
- Update **Request URL** to: `https://your-app.railway.app/slack/events`
- Update **OAuth Redirect URL** to: `https://your-app.railway.app/slack/oauth_redirect`

## Expected Results
- ✅ **Much better uptime** (500 hours vs limited free tier)
- ✅ **No 15-minute sleep** issues
- ✅ **Same functionality** as current setup
- ✅ **Free for your usage pattern**

## Backup Plan
If Railway doesn't work, next best options:
1. **Fly.io** (3 VMs free, always-on)
2. **Render Paid** ($7/month - most reliable)