# 🔄 Render Account Migration Checklist

## Current Service Details
- **Service Name**: attendance-bot
- **Current URL**: https://attendance-bot-1dr6.onrender.com
- **Repository**: https://github.com/jithinkumar900/attendance-bot
- **Branch**: main

## Environment Variables to Copy
Copy these from your current Render service → new service:

### Required Slack Variables:
- [ ] `SLACK_BOT_TOKEN` = xoxb-...
- [ ] `SLACK_APP_TOKEN` = xapp-...  
- [ ] `SLACK_SIGNING_SECRET` = ...

### Bot Configuration:
- [ ] `MAX_INTERMEDIATE_HOURS` = 2.5
- [ ] `TRANSPARENCY_CHANNEL` = #intermediate-logout
- [ ] `LEAVE_APPROVAL_CHANNEL` = #leave-approval
- [ ] `HR_TAG` = (your HR user ID)
- [ ] `LEAVE_APPROVAL_TAG` = (your leave approver user ID)
- [ ] `ADMIN_PASSWORD` = (your admin password)

### Keepalive (Will be different URL):
- [ ] `RENDER_URL` = https://NEW-URL.onrender.com (update after deployment)

### Optional:
- [ ] `DATABASE_PATH` = (if set)
- [ ] `NOTIFY_CHANNEL` = (if used)

## Migration Steps

### 1. New Account Setup
- [ ] Create new Render account with different Gmail
- [ ] Connect GitHub to new account
- [ ] Verify email

### 2. Create New Service  
- [ ] New Service → Web Service
- [ ] Connect same GitHub repo: jithinkumar900/attendance-bot
- [ ] Branch: main
- [ ] Build Command: `npm install`
- [ ] Start Command: `npm start`

### 3. Environment Variables
- [ ] Copy all variables from old service to new service
- [ ] Update `RENDER_URL` with new service URL

### 4. Update External References
- [ ] Update Slack App Request URL to new Render URL
- [ ] Test all Slack commands  
- [ ] Verify keepalive logs

### 5. Cleanup
- [ ] Delete old Render service (optional)
- [ ] Update documentation with new URL

## Important Notes
- ⚠️ **Get new URL first** before updating Slack app
- ⚠️ **Test thoroughly** before deleting old service
- ⚠️ **Database will reset** (SQLite starts fresh)
- ✅ **All code and config stays same**