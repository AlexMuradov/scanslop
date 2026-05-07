# Scan Slop - Fight Bots

Captcha verification + link spam detection for Reddit. Automatically challenges unverified users with an image captcha and detects repeated link promotion.

## Captcha Verification

1. A new user posts or comments in your subreddit
2. The content is temporarily removed and a sticky comment appears with a captcha link
3. The user clicks the link, sees a distorted code image, and replies with the code
4. If correct - the user is verified and their content is restored instantly
5. If too many wrong attempts - temporary ban (attempts and ban duration are configurable)

Moderators are always exempt. Verified users are remembered and never challenged again (configurable TTL).

## Link Spam Detection

Monitors posts and comments for repeated promotion of the same URLs or domains. Tracks how often each user posts the same domain.

1. User posts a link to `example.com` - recorded
2. Same user posts `example.com` again - recorded (2/3)
3. Third time within the cooldown window - all posts with that link are removed, user is banned, mods get notified via modmail

Each detection expires individually after the cooldown period (rolling window, not a fixed reset date). Works on all users including verified ones.

## Settings

### Captcha

| Setting | Default | Description |
|---|---|---|
| Verify on posts | true | Challenge unverified users on posts |
| Verify on comments | true | Challenge unverified users on comments |
| Verification TTL | 0 (forever) | How long verification lasts in minutes. 0 = permanent |
| Max attempts | 3 | Wrong codes allowed before temp ban |
| Ban duration | 28 days | Temp ban length after failed captcha |
| Min account age | 0 | Skip accounts older than X days |
| Min karma | 0 | Skip users with karma above X |
| Max held items | 5 | Max posts/comments held per user. Prevents spam-then-verify abuse |
| Check mods | false | Require verification for moderators too |

### Link Spam Detection

| Setting | Default | Description |
|---|---|---|
| Link detection | true | Enable/disable link scanning |
| Cooldown window | 30 days | Rolling window per detection |
| Threshold | 3 | Times a user can post the same domain before action |
| Ban duration | 28 days | 0 = just remove content, no ban |

## Features

- Image-based captcha verification
- Instant verification via comment replies
- Held content is automatically restored after verification
- Works alongside AutoModerator without conflicts
- Link spam detection: tracks how often each user posts the same domain. Set a threshold (e.g. 3 mentions in 30 days) and users who exceed it get their content removed and are restricted from the sub. Each mention expires individually based on a rolling window, so users naturally regain their allowance over time
- Mod notifications via modmail when link spam is detected
- Configurable account age and karma thresholds to skip trusted users
- Collects behavioral signals during verification to detect bot patterns and multi-account abuse
