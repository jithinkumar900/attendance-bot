#!/bin/bash
# 🚄 Migrate to Railway Pro for 24/7 Uptime

echo "🚄 Starting Railway Pro migration..."

# Install Railway CLI
echo "📦 Installing Railway CLI..."
npm install -g @railway/cli

# Login to Railway
echo "🔐 Login to Railway (browser will open)..."
railway login

# Initialize project
echo "🎯 Initializing Railway project..."
railway init

# Deploy your bot
echo "🚀 Deploying to Railway..."
railway up

echo "⚙️ Setting environment variables..."

# Set Slack credentials
railway variables set SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN}"
railway variables set SLACK_APP_TOKEN="${SLACK_APP_TOKEN}" 
railway variables set SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET}"

# Set bot configuration
railway variables set MAX_INTERMEDIATE_HOURS="2.5"
railway variables set TRANSPARENCY_CHANNEL="#intermediate-logout"
railway variables set LEAVE_APPROVAL_CHANNEL="#leave-approval" 
railway variables set HR_TAG="${HR_TAG}"
railway variables set LEAVE_APPROVAL_TAG="${LEAVE_APPROVAL_TAG}"
railway variables set ADMIN_PASSWORD="${ADMIN_PASSWORD}"

echo "💳 Next steps:"
echo "1. Go to Railway dashboard"
echo "2. Upgrade to Pro plan ($5/month)"
echo "3. Get your Railway URL and set RENDER_URL variable"
echo "4. Update Slack app Request URL to your new Railway URL"

echo "✅ Migration complete! Your bot will have 24/7 uptime."