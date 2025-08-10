# 📋 How to Get Current Environment Variables

## Method 1: From Current Render Dashboard
1. Go to your **current Render account**
2. Click on **attendance-bot service**
3. Go to **Environment** tab
4. **Copy each variable** to notepad:
   - Click the "eye" icon to reveal values
   - Copy Key and Value for each variable

## Method 2: From Slack App Dashboard  
For Slack tokens (if you can't access current Render):

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Select your **Attendance Bot** app
3. **OAuth & Permissions**:
   - Copy `Bot User OAuth Token` (starts with `xoxb-`)
4. **Basic Information**:
   - Copy `Signing Secret` 
   - Copy `App-Level Token` (starts with `xapp-`)

## Essential Variables You Need:

### From Slack (Required):
```
SLACK_BOT_TOKEN = xoxb-...
SLACK_APP_TOKEN = xapp-...
SLACK_SIGNING_SECRET = ...
```

### Bot Config (Your choices):
```
MAX_INTERMEDIATE_HOURS = 2.5
TRANSPARENCY_CHANNEL = #intermediate-logout  
LEAVE_APPROVAL_CHANNEL = #leave-approval
ADMIN_PASSWORD = your-password
```

### User IDs (Find in Slack):
```
HR_TAG = U1234567890
LEAVE_APPROVAL_TAG = U0987654321
```

## To Find Slack User IDs:
1. In Slack, right-click on user
2. **View profile**
3. Click **More** → **Copy member ID**
4. Use format: `U1234567890` (not @username)

## Template for New Service:
```bash
# Copy these to new Render service Environment tab:
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_APP_TOKEN=xapp-your-token-here  
SLACK_SIGNING_SECRET=your-secret-here
MAX_INTERMEDIATE_HOURS=2.5
TRANSPARENCY_CHANNEL=#intermediate-logout
LEAVE_APPROVAL_CHANNEL=#leave-approval
HR_TAG=U1234567890
LEAVE_APPROVAL_TAG=U0987654321
ADMIN_PASSWORD=your-password
RENDER_URL=https://your-new-url.onrender.com
```