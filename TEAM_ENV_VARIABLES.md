# Team Lead Environment Variables

## 🏢 Team-Based Approval System Configuration

The attendance bot now uses environment variables to configure team leads for the approval system. This makes it easy to update team leads without modifying code.

## 📋 Required Environment Variables

### **PM Team Lead**
```bash
PM_TEAM_LEAD_ID=U029BPF320H
PM_TEAM_LEAD_NAME=Jesna S
```

### **BD Team Lead**
```bash
BD_TEAM_LEAD_ID=U028HPCPKJA
BD_TEAM_LEAD_NAME=Sruthi Raj
```

### **Accounts Team Lead**
```bash
ACCOUNTS_TEAM_LEAD_ID=U03335B81L3
ACCOUNTS_TEAM_LEAD_NAME=Mohit Madaan
```

## 🔧 How to Set Environment Variables

### **On Render Dashboard:**
1. Go to your service dashboard
2. Navigate to **Environment** tab
3. Add each variable with its value
4. Click **Save Changes**
5. The service will automatically redeploy

### **For Local Development:**
Create a `.env` file in your project root:
```bash
# Team Lead Configuration
PM_TEAM_LEAD_ID=U029BPF320H
PM_TEAM_LEAD_NAME=Jesna S

BD_TEAM_LEAD_ID=U028HPCPKJA
BD_TEAM_LEAD_NAME=Sruthi Raj

ACCOUNTS_TEAM_LEAD_ID=U03335B81L3
ACCOUNTS_TEAM_LEAD_NAME=Mohit Madaan
```

## 🔍 How to Find Slack User IDs

### **Method 1: Copy Member ID**
1. Right-click on the person's name/avatar in Slack
2. Select **"Copy member ID"**
3. You'll get something like: `U1234567890`

### **Method 2: From Profile**
1. Click on their profile in Slack
2. Click **"More"** → **"Copy member ID"**

### **Method 3: From Web Browser**
1. Go to their Slack profile
2. Look at the URL: `https://yourworkspace.slack.com/team/U1234567890`
3. The `U1234567890` part is their User ID

## 🔄 Updating Team Leads

To change a team lead:
1. Update the corresponding environment variables
2. Redeploy the service (automatic on Render)
3. The bot will immediately use the new team lead

## 📊 Default Values

If environment variables are not set, the system will use these defaults:
- **PM Team**: Jesna S (`U029BPF320H`)
- **BD Team**: Sruthi Raj (`U028HPCPKJA`)
- **Accounts Team**: Mohit Madaan (`U03335B81L3`)

## ⚠️ Important Notes

1. **User IDs are required** - Display names alone won't work for tagging
2. **Case sensitive** - Environment variable names must match exactly
3. **No spaces** - User IDs should not have spaces
4. **Test after changes** - Always test a leave request after updating team leads

## 🗑️ Deprecated Variables

The following environment variable is **no longer used**:
- ~~`LEAVE_APPROVAL_TAG`~~ - Replaced by team-specific variables

## 🎯 How It Works

When a user submits a leave request:
1. User selects their team (PM/BD/Accounts)
2. System looks up the team lead using environment variables
3. Leave request tags the appropriate team lead
4. Team lead receives notification and can approve/deny

Example flow:
```
User selects "BD" team → System uses BD_TEAM_LEAD_ID → Tags @Sruthi Raj
```
