# 🚀 New Render Account Setup Guide

## Step-by-Step Migration

### 1. Create New Render Service
1. Go to [render.com dashboard](https://dashboard.render.com) (new account)
2. Click **"New +"** → **"Web Service"**
3. **Connect Repository**:
   - Select: `jithinkumar900/attendance-bot`
   - Branch: `main`
4. **Service Settings**:
   - Name: `attendance-bot` (or choose new name)
   - Region: Oregon (or preferred)
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free** (start with free)

### 2. Environment Variables Setup
Go to **Environment** tab and add these variables:

#### Slack Configuration:
```
SLACK_BOT_TOKEN = xoxb-your-bot-token
SLACK_APP_TOKEN = xapp-your-app-token  
SLACK_SIGNING_SECRET = your-signing-secret
```

#### Bot Settings:
```
MAX_INTERMEDIATE_HOURS = 2.5
TRANSPARENCY_CHANNEL = #intermediate-logout
LEAVE_APPROVAL_CHANNEL = #leave-approval
HR_TAG = U1234567890  (your HR user ID)
LEAVE_APPROVAL_TAG = U0987654321  (your leave approver user ID)
ADMIN_PASSWORD = your-admin-password
```

#### Keepalive (Update after getting new URL):
```
RENDER_URL = https://your-new-url.onrender.com
```

### 3. Deploy and Get New URL
1. Click **"Create Web Service"**
2. Wait for deployment (2-3 minutes)
3. **Copy the new URL** (something like: `https://attendance-bot-xyz.onrender.com`)
4. Go back to **Environment** tab
5. **Update RENDER_URL** with the new URL
6. Click **"Save Changes"** (triggers redeploy)

### 4. Update Slack App Configuration
1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Select your attendance bot app
3. **Event Subscriptions**:
   - Request URL: `https://your-new-url.onrender.com/slack/events`
4. **Slash Commands**: Update each command:
   - Request URL: `https://your-new-url.onrender.com/slack/events`
5. **Interactive Components**:
   - Request URL: `https://your-new-url.onrender.com/slack/events`
6. Click **"Save Changes"** for each section

### 5. Test Everything
Test these commands in Slack:
- [ ] `/intermediate_logout 1h test reason`
- [ ] `/planned`  
- [ ] `/return`
- [ ] `/review`
- [ ] `/admin your-password`

### 6. Verify Keepalive
Check logs for:
```
🔄 Keepalive ping successful
🔄 Business hours ping successful
```

## ⚠️ Important Notes

### Database Reset
- SQLite database will be **empty** on new service
- All user data, leave history will be lost
- This is expected behavior

### URLs to Update
- **Old**: https://attendance-bot-1dr6.onrender.com
- **New**: https://your-new-url.onrender.com  
- Update all references to new URL

### Timing
- Keep old service running until new one is tested
- Delete old service only after confirming new one works
- Migration takes ~15-30 minutes total