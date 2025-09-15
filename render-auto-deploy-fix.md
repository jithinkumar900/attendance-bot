# Render Auto-Deploy Troubleshooting Guide

## Issue: Git pushes not triggering automatic deployments

### 🔍 Check These Settings in Render Dashboard

1. **Go to your service**: https://dashboard.render.com/web/srv-XXXXX
2. **Check "Settings" tab**:
   - **Auto-Deploy**: Should be "Yes"
   - **Branch**: Should be "main" (or your default branch)
   - **Repository**: Should show your GitHub repo correctly

### 🔧 Common Fixes

#### Fix 1: Re-enable Auto-Deploy
1. Go to Service Settings
2. Scroll to "Auto-Deploy"
3. If it's "No", click "Edit" and change to "Yes"
4. Save changes

#### Fix 2: Check Repository Connection
1. In Settings, look for "Repository" section
2. If showing "Not connected" or wrong repo:
   - Click "Connect Account" 
   - Re-authorize GitHub access
   - Select correct repository

#### Fix 3: Manual Deploy to Test
1. Go to "Manual Deploy" section
2. Click "Deploy latest commit"
3. This should trigger a deployment
4. Check if auto-deploy works for next push

#### Fix 4: Check Branch Configuration
1. Ensure "Branch" is set to "main"
2. If your default branch is different, update it
3. Make sure you're pushing to the correct branch

### 🚨 Force Auto-Deploy Reset

If the above doesn't work, try this sequence:

1. **Disconnect Repository**:
   - Settings → Repository → Disconnect
   
2. **Reconnect Repository**:
   - Settings → Repository → Connect Account
   - Re-authorize GitHub
   - Select your repo again
   
3. **Re-enable Auto-Deploy**:
   - Settings → Auto-Deploy → Yes
   
4. **Test with a small change**:
   ```bash
   git commit --allow-empty -m "Test auto-deploy"
   git push
   ```

### 📊 Check Deployment Status

#### In Render Dashboard:
- **"Events" tab**: Shows deployment history
- **"Logs" tab**: Shows build and deployment logs
- **Green circle**: Service is healthy
- **Red circle**: Deployment failed

#### Expected Behavior:
1. Push to GitHub
2. Within 1-2 minutes, see "Deploy started" in Events
3. Build process begins (3-5 minutes)
4. Service restarts with new code

### 🔧 Alternative: Webhook Deployment

If auto-deploy still doesn't work, you can set up manual webhook triggers:

1. **Get Deploy Hook URL**:
   - Settings → Deploy Hook
   - Copy the URL (looks like: `https://api.render.com/deploy/srv-XXXXX?key=XXXXX`)

2. **Trigger manually after each push**:
   ```bash
   git push
   curl -X POST "https://api.render.com/deploy/srv-XXXXX?key=XXXXX"
   ```

3. **Set up GitHub Action** (optional):
   ```yaml
   # .github/workflows/deploy.yml
   name: Deploy to Render
   on:
     push:
       branches: [ main ]
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - name: Trigger Render Deploy
           run: |
             curl -X POST "${{ secrets.RENDER_DEPLOY_HOOK }}"
   ```

### 🔍 Debugging Steps

1. **Check recent commits**:
   ```bash
   git log --oneline -5
   ```

2. **Verify remote repository**:
   ```bash
   git remote -v
   ```

3. **Check if push was successful**:
   - Go to your GitHub repo
   - Verify latest commit shows up
   - Check commit timestamp

4. **Monitor Render Events**:
   - Dashboard → Your Service → Events tab
   - Should show "Deploy started" within 2 minutes of push

### 📞 When to Contact Support

Contact Render support if:
- Auto-deploy setting is "Yes" but not working
- Repository shows as connected but deploys don't trigger
- Manual deploy works but auto-deploy doesn't
- Error messages in Events tab

### 🎯 Quick Test

Try this to test auto-deploy:

```bash
# Make a harmless change
echo "# Last updated: $(date)" >> README.md
git add README.md
git commit -m "Test auto-deploy trigger"
git push

# Then watch Render dashboard Events tab for deploy activity
```

### 📱 Render Mobile App

The Render mobile app can help monitor deployments on the go:
- iOS: https://apps.apple.com/app/render/id1534424881
- Android: https://play.google.com/store/apps/details?id=com.render.mobile

---

## Current Service Info

**Service URL**: https://attendance-bot-1dr6.onrender.com
**Repository**: https://github.com/jithinkumar900/attendance-bot
**Branch**: main
**Auto-Deploy**: Should be enabled

After following these steps, your pushes should automatically trigger deployments within 1-2 minutes!
