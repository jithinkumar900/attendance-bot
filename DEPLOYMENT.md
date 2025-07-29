# 🚀 Render Deployment Guide

## 📋 Required Environment Variables

### **Slack Configuration (REQUIRED)**
```
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

### **Bot Settings (Optional - has defaults)**
```
MAX_INTERMEDIATE_HOURS=2.5
WORKING_HOURS_PER_DAY=8
EXTRA_WORK_DEADLINE_DAYS=7
ADMIN_PASSWORD=your-secure-password
TRANSPARENCY_CHANNEL=#intermediate-logout
LEAVE_APPROVAL_CHANNEL=#leave-approval
HR_TAG=U1234567890
LEAVE_APPROVAL_TAG=U0987654321
```

### **🔍 How to Find Slack User IDs**
**HR_TAG and LEAVE_APPROVAL_TAG require Slack User IDs, not display names!**

**Method 1: Via Slack Web/Desktop**
1. Go to the person's profile in Slack
2. Click "More" → "Copy member ID"
3. Use this ID (starts with "U") in your environment variables

**Method 2: Via Slack Message**
1. Right-click on any message from the person
2. Select "Copy link" 
3. The link contains their user ID: `...team/U1234567890/...`

**Method 3: Via Slack Settings**
1. Go to your Slack workspace settings
2. Navigate to "Members" 
3. Find the person and their ID will be visible

**Example:**
- ❌ Wrong: `HR_TAG=Anju Maria`
- ✅ Correct: `HR_TAG=U1234567890`

### **Notifications (Optional)**
```
NOTIFY_USERS=@hr-team,@manager,@admin
NOTIFY_CHANNELS=#hr-notifications,#management
```

### **System Settings**
```
DATABASE_PATH=./attendance.db
PORT=10000
NODE_ENV=production
RENDER_URL=https://your-app-name.onrender.com
```

---

## 🎯 **Quick Render Deployment**

### **Step 1: Push to GitHub**
```bash
git add .
git commit -m "Ready for Render deployment"
git push origin main
```

### **Step 2: Create Render Service**
1. Go to [render.com](https://render.com)
2. Sign up with GitHub
3. Click "New" → "Web Service"
4. Connect your repository
5. Configure:
   - **Name**: `attendance-bot`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

### **Step 3: Add Environment Variables**
Copy-paste these in Render's Environment Variables section:

**REQUIRED (Replace with your actual values):**
```
SLACK_BOT_TOKEN=xoxb-your-actual-token
SLACK_SIGNING_SECRET=your-actual-secret
SLACK_APP_TOKEN=xapp-your-actual-token
```

**OPTIONAL (Customize as needed):**
```
ADMIN_PASSWORD=MySecurePassword123
TRANSPARENCY_CHANNEL=#company-leave
LEAVE_APPROVAL_CHANNEL=#leave-approvals
HR_TAG=U1234567890
LEAVE_APPROVAL_TAG=U0987654321
NOTIFY_USERS=@hr-team,@ceo
MAX_INTERMEDIATE_HOURS=3.0
```

### **Step 4: Deploy**
Click "Create Web Service" and wait for deployment!

---

## ✅ **Benefits of Environment Variables**

### **Easy Updates (No Code Changes):**
- ✅ **Change HR person**: Update `HR_TAG` in Render dashboard
- ✅ **Change leave approver**: Update `LEAVE_APPROVAL_TAG` 
- ✅ **Change admin password**: Update `ADMIN_PASSWORD` 
- ✅ **Change notification users**: Update `NOTIFY_USERS`
- ✅ **Change time limits**: Update `MAX_INTERMEDIATE_HOURS`

### **Instant Changes:**
1. Go to Render dashboard
2. Edit environment variable
3. Service automatically restarts
4. Changes are live immediately!

---

## 🔧 **Common Customizations**

### **For Stricter Policy:**
```
MAX_INTERMEDIATE_HOURS=2.0
EXTRA_WORK_DEADLINE_DAYS=5
```

### **For Multiple Channels:**
```
TRANSPARENCY_CHANNEL=#attendance-tracking
NOTIFY_CHANNELS=#hr,#management,#operations
```

### **For Different Form:**
```
HALF_DAY_FORM_URL=https://your-company.typeform.com/half-day-request
```

---

## 🚨 **Security Notes**

- **Never commit** `.env` file to GitHub
- **Slack tokens** are sensitive - only add them in Render dashboard
- **Admin password** should be strong
- **Form URL** can be public

---

## 📊 **Monitoring Your Bot**

### **Render Dashboard Shows:**
- ✅ **Deployment status**
- ✅ **Live logs**
- ✅ **Environment variables**
- ✅ **Resource usage**

### **Bot Startup Logs:**
```
⚡️ Attendance Bot is running!
📍 Configuration:
  • Max unplanned hours: 2.5h
  • Transparency channel: #unplanned-leave
  • Admin password set: ✅
  • Half-day form: https://forms.google.com/...
🚀 Available commands: [list of commands]
```

---

## 🔄 **Making Changes**

### **Code Changes:**
1. Edit files locally
2. `git commit` and `git push`
3. Render auto-deploys new version

### **Settings Changes:**
1. Go to Render dashboard
2. Environment Variables tab
3. Edit values
4. Service restarts automatically

**No code changes needed for most settings!** 🎉 