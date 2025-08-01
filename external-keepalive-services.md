# 🔄 External Keepalive Services for Render Free

## Option A: UptimeRobot (Free)
1. Sign up at [uptimerobot.com](https://uptimerobot.com)
2. Add monitor:
   - **Type**: HTTP(s)
   - **URL**: `https://your-render-app.onrender.com/ping`
   - **Interval**: 5 minutes
   - **Alert contacts**: Your email

## Option B: Pingdom (Free tier)
1. Sign up at [pingdom.com](https://www.pingdom.com)
2. Create monitor:
   - **URL**: `https://your-render-app.onrender.com/ping`
   - **Check interval**: 5 minutes

## Option C: StatusCake (Free)
1. Sign up at [statuscake.com](https://www.statuscake.com)
2. Add test:
   - **Website URL**: `https://your-render-app.onrender.com/ping`
   - **Check rate**: Every 5 minutes

## Benefits
- ✅ **External pings** keep your app awake
- ✅ **Monitor uptime** and get alerts if down
- ✅ **Free tiers available** for basic monitoring
- ✅ **Works with current setup** - no code changes needed

## Why This Helps
- External services ping your Render app every 5 minutes
- Prevents the 15-minute idle spin-down
- Gives you uptime monitoring as bonus
- Buys time while you plan migration