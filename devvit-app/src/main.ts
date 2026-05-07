import { Devvit } from "@devvit/public-api";
import type { TriggerContext } from "@devvit/public-api";
import { CAPTCHA_SERVER_URL, CAPTCHA_SECRET_KEY, TELEGRAM_READER_TOKEN, TELEGRAM_CHAT_ID } from "./config.js";

Devvit.configure({ redditAPI: true, redis: true });

// --- Settings ---
Devvit.addSettings([
  {
    name: "verification-ttl",
    label: "How long verification lasts (minutes). 0 = forever.",
    helpText: "📊 Access your moderator dashboard via the 'ScanSlop Dashboard' option in your subreddit's three-dot menu.",
    type: "number",
    scope: "installation",
    defaultValue: 0,
  },
  {
    name: "max-attempts",
    label: "Max wrong captcha attempts before ban",
    type: "number",
    scope: "installation",
    defaultValue: 3,
  },
  {
    name: "ban-days",
    label: "Ban duration (days) after failed captcha",
    type: "number",
    scope: "installation",
    defaultValue: 28,
  },
  {
    name: "check-posts",
    label: "Verify users on posts",
    type: "boolean",
    scope: "installation",
    defaultValue: true,
  },
  {
    name: "check-comments",
    label: "Verify users on comments",
    type: "boolean",
    scope: "installation",
    defaultValue: true,
  },
  {
    name: "min-account-age-days",
    label: "Skip verification for accounts older than X days. 0 = check everyone.",
    type: "number",
    scope: "installation",
    defaultValue: 0,
  },
  {
    name: "min-karma",
    label: "Skip verification for users with karma above X. 0 = check everyone.",
    type: "number",
    scope: "installation",
    defaultValue: 0,
  },
  {
    name: "max-held-items",
    label: "Max posts/comments held per user before verification. 0 = unlimited.",
    type: "number",
    scope: "installation",
    defaultValue: 5,
  },
  {
    name: "check-mods",
    label: "Require verification for moderators too",
    type: "boolean",
    scope: "installation",
    defaultValue: false,
  },
  {
    name: "link-detection",
    label: "Enable link spam detection",
    type: "boolean",
    scope: "installation",
    defaultValue: true,
  },
  {
    name: "link-cooldown-days",
    label: "Link detection window (days). Detections older than this are ignored.",
    type: "number",
    scope: "installation",
    defaultValue: 30,
  },
  {
    name: "link-threshold",
    label: "How many times a user can post the same link within the window before action.",
    type: "number",
    scope: "installation",
    defaultValue: 3,
  },
  {
    name: "link-ban-days",
    label: "Ban duration (days) for link spammers. 0 = no ban, just remove.",
    type: "number",
    scope: "installation",
    defaultValue: 28,
  },
  {
    name: "add-to-approved-users",
    label: "Auto-add verified users to subreddit's Approved Users list (exempts them from AutoMod)",
    type: "boolean",
    scope: "installation",
    defaultValue: true,
  },
  {
    name: "link-allowlist",
    label: "Link allowlist (comma-separated). Use *.example.com to match all subdomains.",
    type: "string",
    scope: "installation",
    defaultValue: "*.reddit.com,redd.it,*.imgur.com,*.youtube.com,youtu.be,*.twitter.com,x.com,*.github.com,*.wikipedia.org,*.google.com",
  },
]);

// --- Config ---
const MAX_ATTEMPTS = 3;
const BAN_DAYS = 28;
const BOT_NAME = "scanslop";
const IGNORED_USERS = new Set(["scanslop", "AutoModerator"]);

// --- Send event to Telegram for dashboard sync ---
async function sendEvent(text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_READER_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch {}
}

// --- Dashboard key derivation (must match Worker's deriveDashboardKey) ---
async function deriveDashboardKey(subreddit: string, timestamp: number): Promise<string> {
  const data = new TextEncoder().encode(CAPTCHA_SECRET_KEY + ":" + subreddit + ":" + timestamp);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// --- Simple token encryption ---
function simpleEncode(code: string, username: string, secretKey: string, subreddit: string = ""): string {
  const payload = `${code}|${username}|${Date.now()}|${subreddit}`;
  const keyBytes = secretKey.split("").map((c) => c.charCodeAt(0));
  const encoded = payload
    .split("")
    .map((c, i) => c.charCodeAt(0) ^ keyBytes[i % keyBytes.length])
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(encoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCode(): string {
  const chars = "0123456789abcdef";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// --- Redis keys ---
const approvedKey = (u: string) => `approved:${u}`;
const pendingKey = (u: string) => `pending:${u}`;
const heldKey = (u: string) => `held:${u}`;
const processedKey = (id: string) => `processed:${id}`;
const botCommentKey = (commentId: string) => `botcomment:${commentId}`;
const threadKey = (username: string) => `thread:${username}`;

async function isApproved(redis: TriggerContext["redis"], username: string): Promise<boolean> {
  const val = await redis.get(approvedKey(username));
  return val === "1";
}

async function approveUser(
  context: { redis: TriggerContext["redis"]; settings: TriggerContext["settings"]; reddit?: TriggerContext["reddit"]; subredditId?: string },
  username: string
): Promise<void> {
  const { redis, settings } = context;
  await redis.set(approvedKey(username), "1");

  const ttlMinutes = ((await settings.get("verification-ttl")) as number) || 0;
  if (ttlMinutes > 0) {
    await redis.expire(approvedKey(username), ttlMinutes * 60);
  }

  await redis.del(pendingKey(username));
  await redis.del(heldKey(username));
  await redis.del(threadKey(username));

  // Also add to Reddit's "Approved users" list to exempt from AutoMod restrictions
  const addToApprovedList = await settings.get("add-to-approved-users");
  if (addToApprovedList !== false && context.reddit && context.subredditId) {
    try {
      const sub = await context.reddit.getSubredditById(context.subredditId);
      if (sub) {
        await sub.approveUser(username);
        console.log(`Added u/${username} to subreddit's approved users`);
      }
    } catch (e) {
      console.log(`Could not add u/${username} to approved users: ${e}`);
    }
  }
}

async function getPending(redis: TriggerContext["redis"], username: string): Promise<{ code: string; attempts: number; botCommentId?: string } | null> {
  const data = await redis.hGetAll(pendingKey(username));
  if (!data || !data.code) return null;
  return { code: data.code, attempts: parseInt(data.attempts || "0", 10), botCommentId: data.botCommentId };
}

async function createChallenge(redis: TriggerContext["redis"], username: string, code: string): Promise<void> {
  await redis.hSet(pendingKey(username), { code, attempts: "0" });
  await redis.expire(pendingKey(username), 60 * 60 * 24);
}

async function incrementAttempts(redis: TriggerContext["redis"], username: string): Promise<number> {
  return await redis.hIncrBy(pendingKey(username), "attempts", 1);
}

async function holdContent(redis: TriggerContext["redis"], username: string, contentId: string, maxItems: number): Promise<boolean> {
  if (maxItems > 0) {
    const existing = await redis.zRange(heldKey(username), 0, -1);
    if (existing.length >= maxItems) {
      return false;
    }
  }
  await redis.zAdd(heldKey(username), { member: contentId, score: Date.now() });
  await redis.expire(heldKey(username), 60 * 60 * 24);
  return true;
}

async function getHeldContent(redis: TriggerContext["redis"], username: string): Promise<string[]> {
  const items = await redis.zRange(heldKey(username), 0, -1);
  return items.map((item) => item.member);
}

async function isProcessed(redis: TriggerContext["redis"], sourceId: string): Promise<boolean> {
  const val = await redis.get(processedKey(sourceId));
  return val !== undefined;
}

async function markProcessed(redis: TriggerContext["redis"], sourceId: string): Promise<void> {
  await redis.set(processedKey(sourceId), "1");
  await redis.expire(processedKey(sourceId), 60 * 60 * 24 * 7);
}

// ============================================================
// LINK SPAM DETECTION
// ============================================================

const TLDS = [
  "com", "org", "net", "io", "ai", "co", "app", "dev", "me", "info",
  "biz", "xyz", "tech", "online", "store", "shop", "site", "club",
  "gg", "tv", "cc", "ly", "to", "sh", "so", "is", "fm", "im",
  "us", "uk", "ca", "de", "fr", "es", "it", "nl", "au", "in",
  "ru", "br", "jp", "kr", "cn", "pl", "se", "no", "fi", "dk",
  "be", "at", "ch", "cz", "ie", "pt", "nz", "za", "mx", "ar",
  "edu", "gov", "mil", "int",
];

const TLD_PATTERN = new RegExp(
  `(?:^|\\s|[([{<,;:'"!?])` +                       // boundary before
  `((?:https?://)?` +                                 // optional protocol
  `(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+` + // subdomains
  `(?:${TLDS.join("|")})` +                           // TLD
  `)` +
  `(?:[/\\s)\\]}>.,;:'"!?]|$)`,                      // boundary after
  "gi"
);

function isAllowed(domain: string, allowlist: Set<string>): boolean {
  for (const entry of allowlist) {
    if (entry.startsWith("*.")) {
      // Wildcard: matches the base domain and any subdomain
      const base = entry.slice(2);
      if (domain === base || domain.endsWith("." + base)) return true;
    } else {
      // Exact match only
      if (domain === entry) return true;
    }
  }
  return false;
}

function extractDomains(text: string, allowlist: Set<string>): string[] {
  const domains = new Set<string>();
  const matches = text.matchAll(TLD_PATTERN);
  for (const match of matches) {
    let domain = match[1]!.toLowerCase();
    domain = domain.replace(/^https?:\/\//, "");
    domain = domain.replace(/\/.*$/, "");
    if (isAllowed(domain, allowlist)) continue;
    if (domain.length < 4) continue;
    domains.add(domain);
  }
  return Array.from(domains);
}

// Redis keys for link detection
// linkdetect:{username}:{domain} -> sorted set, member = sourceType:sourceId, score = timestamp
const linkKey = (username: string, domain: string) => `linkdetect:${username}:${domain}`;
// linkref:{sourceId} -> hash { username, domain, timestamp } for reverse lookup
const linkRefKey = (sourceId: string) => `linkref:${sourceId}`;

async function recordLinkDetection(
  redis: TriggerContext["redis"],
  username: string,
  domain: string,
  sourceType: string,
  sourceId: string,
  cooldownDays: number
): Promise<number> {
  const key = linkKey(username, domain);
  const now = Date.now();
  const windowStart = now - cooldownDays * 86400000;

  // Add this detection
  await redis.zAdd(key, { member: `${sourceType}:${sourceId}`, score: now });
  // TTL slightly longer than cooldown so old entries expire
  await redis.expire(key, (cooldownDays + 1) * 86400);

  // Store reverse lookup so we can find all content for a domain
  await redis.hSet(linkRefKey(sourceId), {
    username,
    domain,
    sourceType,
    timestamp: now.toString(),
  });
  await redis.expire(linkRefKey(sourceId), (cooldownDays + 1) * 86400);

  // Count detections within the window
  const all = await redis.zRange(key, 0, -1);
  let countInWindow = 0;
  for (const item of all) {
    if (item.score >= windowStart) {
      countInWindow++;
    }
  }

  return countInWindow;
}

async function getLinkDetections(
  redis: TriggerContext["redis"],
  username: string,
  domain: string,
  cooldownDays: number
): Promise<Array<{ member: string; score: number }>> {
  const key = linkKey(username, domain);
  const windowStart = Date.now() - cooldownDays * 86400000;
  const all = await redis.zRange(key, 0, -1);
  return all.filter((item) => item.score >= windowStart);
}

async function handleLinkDetection(
  context: TriggerContext,
  username: string,
  text: string,
  sourceType: string,
  sourceId: string,
  subredditName: string,
  postIdContext: string = ""
): Promise<boolean> {
  const { redis, reddit, settings } = context;

  const linkDetection = await settings.get("link-detection");
  if (linkDetection === false) return false;

  const allowlistStr = ((await settings.get("link-allowlist")) as string) || "";
  const allowlist = new Set(allowlistStr.split(",").map(d => d.trim().toLowerCase()).filter(Boolean));

  const domains = extractDomains(text, allowlist);
  if (domains.length === 0) return false;

  const cooldownDays = ((await settings.get("link-cooldown-days")) as number) || 30;
  const threshold = ((await settings.get("link-threshold")) as number) || 3;
  const banDays = ((await settings.get("link-ban-days")) as number) || 28;

  let spamDetected = false;

  for (const domain of domains) {
    const count = await recordLinkDetection(redis, username, domain, sourceType, sourceId, cooldownDays);
    console.log(`Link detected: u/${username} -> ${domain} (${count}/${threshold} in ${cooldownDays}d)`);

    // Send link detection event to Telegram for dashboard sync
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_READER_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `EVT:link|${subredditName}|${username}|${domain}|${sourceType}|${sourceId}|${postIdContext || ""}`,
        }),
      });
    } catch {}

    // Warn user on their last chance before action (only if verified - unverified users have captcha flow)
    if (count === threshold - 1 && threshold > 1 && await isApproved(redis, username)) {
      try {
        const itemId = sourceId.startsWith("t") ? sourceId : (sourceType === "post" ? `t3_${sourceId}` : `t1_${sourceId}`);
        const warning = await reddit.submitComment({
          id: itemId,
          text:
            `⚠️ **Warning: repeated link promotion detected**\n\n` +
            `You've shared **${domain}** ${count} times in this subreddit. ` +
            `One more post or comment with this link and your content will be automatically removed and you may be banned.\n\n` +
            `If you believe this is a mistake, please send a modmail to request this domain be whitelisted.`,
        });
        await warning.distinguish(true);
        await warning.approve();
        console.log(`Warned u/${username} about ${domain} (${count}/${threshold})`);
      } catch (e) {
        console.log(`Could not warn u/${username} (likely banned or content removed): ${e}`);
      }
    }

    if (count >= threshold) {
      spamDetected = true;
      console.log(`LINK SPAM: u/${username} promoted ${domain} ${count} times`);

      // Get all detections for this domain within window and remove them
      const detections = await getLinkDetections(redis, username, domain, cooldownDays);
      for (const det of detections) {
        const [type, id] = det.member.split(":");
        if (!type || !id) continue;
        try {
          if (type === "post") {
            const post = await reddit.getPostById(id);
            await post.remove();
          } else {
            const comment = await reddit.getCommentById(id);
            await comment.remove();
          }
          console.log(`Removed ${type} ${id} (link spam: ${domain})`);
        } catch {
          // already removed or not found
        }
      }

      // Ban the user
      if (banDays > 0) {
        try {
          await reddit.banUser({
            username,
            subredditName,
            duration: banDays,
            reason: `Link spam: ${domain} (${count}x in ${cooldownDays} days)`,
            message: `You have been temporarily banned for ${banDays} days for repeatedly promoting ${domain}.`,
            note: `ScanSlop link spam: ${domain} x${count}`,
          });
          console.log(`BANNED u/${username} for link spam: ${domain}`);
          await sendEvent(`EVT:ban|${subredditName}|${username}|link_spam:${domain}|${banDays}`);
        } catch (e) {
          console.error(`Failed to ban u/${username}: ${e}`);
        }
      }

      // Notify via modmail
      try {
        const sub = await reddit.getSubredditByName(subredditName);
        await reddit.modMail.createModInboxConversation({
          subredditId: sub.id,
          subject: `Link spam detected: u/${username}`,
          bodyMarkdown:
            `**ScanSlop** detected repeated link promotion.\n\n` +
            `- **User:** u/${username}\n` +
            `- **Domain:** ${domain}\n` +
            `- **Times posted:** ${count} (threshold: ${threshold})\n` +
            `- **Window:** ${cooldownDays} days\n` +
            `- **Action:** ${banDays > 0 ? `banned ${banDays} days` : "content removed"}\n` +
            `- **Posts/comments removed:** ${detections.length}`,
        });
      } catch (e) {
        console.error(`Failed to send modmail: ${e}`);
      }

      break; // one spam detection per content is enough
    }
  }

  return spamDetected;
}

// ============================================================
// CAPTCHA HELPERS (continued)
// ============================================================

async function markBotComment(redis: TriggerContext["redis"], commentId: string, username: string): Promise<void> {
  await redis.set(botCommentKey(commentId), username);
  await redis.expire(botCommentKey(commentId), 60 * 60 * 24);
  // Track for auto-cleanup
  await redis.zAdd("cleanup:botcomments", { member: commentId, score: Date.now() });
}

async function addToThread(redis: TriggerContext["redis"], username: string, commentId: string): Promise<void> {
  await redis.zAdd(threadKey(username), { member: commentId, score: Date.now() });
  await redis.expire(threadKey(username), 60 * 60 * 24);
}

async function getThreadComments(redis: TriggerContext["redis"], username: string): Promise<string[]> {
  const items = await redis.zRange(threadKey(username), 0, -1);
  return items.map((item) => item.member);
}

async function getBotCommentUser(redis: TriggerContext["redis"], parentCommentId: string): Promise<string | null> {
  const val = await redis.get(botCommentKey(parentCommentId));
  return val ?? null;
}

// --- Check if user is a moderator ---
async function isModerator(reddit: TriggerContext["reddit"], subredditName: string, username: string): Promise<boolean> {
  try {
    const sub = await reddit.getSubredditByName(subredditName);
    const mods = await sub.getModerators().all();
    return mods.some((mod) => mod.username === username);
  } catch {
    return false;
  }
}

// --- Check if user should be skipped based on account age/karma ---
async function shouldSkipUser(reddit: TriggerContext["reddit"], settings: TriggerContext["settings"], username: string): Promise<boolean> {
  const minAgeDays = ((await settings.get("min-account-age-days")) as number) || 0;
  const minKarma = ((await settings.get("min-karma")) as number) || 0;

  if (minAgeDays === 0 && minKarma === 0) return false;

  try {
    const user = await reddit.getUserByUsername(username);
    if (!user) return false;
    const accountAgeDays = (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24);

    if (minAgeDays > 0 && accountAgeDays >= minAgeDays) return true;
    if (minKarma > 0 && (user.linkKarma + user.commentKarma) >= minKarma) return true;
  } catch {
    // Can't fetch user info, don't skip
  }
  return false;
}

// --- Handle new post from unvetted user ---
async function handleNewPost(
  context: TriggerContext,
  username: string,
  postId: string,
  subredditName: string
) {
  const { redis, reddit, settings } = context;

  const checkPosts = await settings.get("check-posts");
  if (checkPosts === false) return;

  if (IGNORED_USERS.has(username)) return;
  const checkMods = await settings.get("check-mods");
  if (checkMods !== true && await isModerator(reddit, subredditName, username)) return;
  if (await isProcessed(redis, postId)) return;
  await markProcessed(redis, postId);
  if (await isApproved(redis, username)) return;
  if (await shouldSkipUser(reddit, settings, username)) return;

  // Wait for AutoMod then check mod log
  await new Promise((resolve) => setTimeout(resolve, 5000));

  try {
    const sub = await reddit.getSubredditByName(subredditName);
    const modLog = await sub.getModerationLog({
      type: "removelink",
      limit: 20,
    }).all();
    const wasRemoved = modLog.some((entry) =>
      entry.target?.id === postId || entry.target?.id === `t3_${postId}`
    );
    if (wasRemoved) {
      console.log(`Post ${postId} found in mod log as removed, skipping`);
      return;
    }
  } catch (e) {
    console.log(`Mod log check failed: ${e}`);
  }

  // Generate captcha
  const existing = await getPending(redis, username);
  const code = existing ? existing.code : generateCode();
  if (!existing) {
    await createChallenge(redis, username, code);
  }

  const token = simpleEncode(code, username, CAPTCHA_SECRET_KEY, subredditName);
  const captchaLink = `${CAPTCHA_SERVER_URL}/c/${token}`;

  // Leave a sticky comment BEFORE removing (so notification fires)
  try {
    const notice = await reddit.submitComment({
      id: postId,
      text:
        `**This post has been temporarily removed for verification.**\n\n` +
        `To prove you're human, click the link below to see your verification code:\n\n` +
        `**[Click here to get your code](${captchaLink})**\n\n` +
        `Then reply to this comment with just the 6-character code.\n\n` +
        `This is a one-time check — once verified, all your future posts will go through automatically.`,
    });
    await notice.distinguish(true);
      await notice.approve();
    await markBotComment(redis, notice.id, username);
    await redis.hSet(pendingKey(username), { botCommentId: notice.id });
    await addToThread(redis, username, notice.id);
    console.log(`Left verification comment ${notice.id} for u/${username}`);
  } catch (e) {
    console.error(`Failed to leave verification comment: ${e}`);
  }

  // Now remove the post
  try {
    const post = await reddit.getPostById(postId);
    await post.remove();
  } catch (e) {
    console.error(`Failed to remove post ${postId}: ${e}`);
    return;
  }

  const maxHeld = ((await settings.get("max-held-items")) as number) ?? 5;
  await holdContent(redis, username, postId, maxHeld);
}

// --- Handle comment: check if it's a captcha reply ---
async function handleComment(
  context: TriggerContext,
  username: string,
  commentId: string,
  commentBody: string,
  parentId: string,
  subredditName: string
) {
  const { redis, reddit } = context;

  if (IGNORED_USERS.has(username)) return;

  // Check if this is a captcha reply (user replying to bot's verification comment)
  const challengedUser = await getBotCommentUser(redis, parentId);

  // If NOT a captcha reply, wait for AutoMod then check mod log
  if (!challengedUser) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check mod log for recent removal of this content
    try {
      const sub = await reddit.getSubredditByName(subredditName);
      const modLog = await sub.getModerationLog({
        type: "removecomment",
        limit: 20,
      }).all();
      const wasRemoved = modLog.some((entry) =>
        entry.target?.id === commentId || entry.target?.id === `t1_${commentId}`
      );
      if (wasRemoved) {
        console.log(`Comment ${commentId} found in mod log as removed, skipping`);
        return;
      }
    } catch (e) {
      console.log(`Mod log check failed: ${e}`);
    }
  }

  if (challengedUser) {
    console.log(`Captcha reply from u/${username}: "${commentBody.trim()}"`);
    await addToThread(redis, username, commentId);

    if (username !== challengedUser) {
      console.log(`u/${username} replied but challenge is for u/${challengedUser}, ignoring`);
      return;
    }

    const pending = await getPending(redis, username);
    if (!pending) {
      console.log(`No pending challenge for u/${username}`);
      return;
    }

    const reply = commentBody.trim().toLowerCase();
    const expected = pending.code.toLowerCase();

    if (reply === expected) {
      // Correct! Re-approve held content BEFORE clearing data
      const held = await getHeldContent(redis, username);
      for (const itemId of held) {
        try {
          if (itemId.startsWith("t3_")) {
            const post = await reddit.getPostById(itemId);
            await post.approve();
          } else {
            const comment = await reddit.getCommentById(itemId);
            await comment.approve();
          }
          console.log(`Re-approved ${itemId}`);
        } catch (e) {
          console.error(`Failed to re-approve ${itemId}: ${e}`);
        }
      }

      // Delete all comments in the verification thread
      const threadComments = await getThreadComments(redis, username);
      for (const cId of threadComments) {
        try {
          const c = await reddit.getCommentById(cId);
          if (c.authorName === BOT_NAME) {
            await c.delete();
          } else {
            await c.remove();
            await c.lock();
          }
        } catch {
          // already deleted or not found
        }
      }
      await redis.del(threadKey(username));
      console.log(`Cleaned up ${threadComments.length} verification comments`);

      await approveUser(context, username);
      console.log(`APPROVED: u/${username}`);
    } else {
      // Wrong code
      const maxAttempts = ((await context.settings.get("max-attempts")) as number) || MAX_ATTEMPTS;
      const banDays = ((await context.settings.get("ban-days")) as number) || BAN_DAYS;
      const attempts = await incrementAttempts(redis, username);
      console.log(`u/${username} failed attempt ${attempts}/${maxAttempts}`);

      if (attempts >= maxAttempts) {
        try {
          await reddit.banUser({
            username,
            subredditName,
            duration: banDays,
            reason: `Failed captcha ${maxAttempts} times`,
            message: `Temporarily banned for ${banDays} days after failing verification ${maxAttempts} times.`,
            note: `ScanSlop: ${maxAttempts} failed attempts`,
          });
        } catch (e) {
          console.error(`Failed to ban u/${username}: ${e}`);
        }

        await redis.del(pendingKey(username));
        await redis.del(heldKey(username));

        try {
          const banNotice = await reddit.submitComment({
            id: commentId,
            text: `❌ Too many failed attempts. You have been temporarily banned for ${banDays} days.`,
          });
          await banNotice.approve();
        } catch (e) {
          console.error(`Failed to post ban notice: ${e}`);
        }

        console.log(`BANNED: u/${username} for ${banDays} days`);
      } else {
        const remaining = maxAttempts - attempts;
        const retryToken = simpleEncode(pending.code, username, CAPTCHA_SECRET_KEY, subredditName);
        const retryLink = `${CAPTCHA_SERVER_URL}/c/${retryToken}`;

        try {
          const retryNotice = await reddit.submitComment({
            id: commentId,
            text:
              `❌ Incorrect code. You have **${remaining}** attempt(s) remaining.\n\n` +
              `**[Click here to see your code again](${retryLink})**`,
          });
          await retryNotice.approve();
          await markBotComment(redis, retryNotice.id, challengedUser);
          await addToThread(redis, username, retryNotice.id);
        } catch (e) {
          console.error(`Failed to post retry notice: ${e}`);
        }
      }
    }
    return;
  }

  // Not a captcha reply — treat as normal content from unvetted user
  // (AutoMod check already happened above)
  const checkComments = await context.settings.get("check-comments");
  if (checkComments === false) return;
  const checkMods = await context.settings.get("check-mods");
  if (checkMods !== true && await isModerator(reddit, subredditName, username)) return;

  if (await isProcessed(redis, commentId)) return;
  await markProcessed(redis, commentId);
  if (await isApproved(redis, username)) return;
  if (await shouldSkipUser(reddit, context.settings, username)) return;

  // Check if already challenged
  const existingChallenge = await getPending(redis, username);

  if (!existingChallenge) {
    // Generate captcha and reply BEFORE removing (so notification fires)
    const code = generateCode();
    await createChallenge(redis, username, code);

    const token = simpleEncode(code, username, CAPTCHA_SECRET_KEY, subredditName);
    const captchaLink = `${CAPTCHA_SERVER_URL}/c/${token}`;

    try {
      const notice = await reddit.submitComment({
        id: commentId,
        text:
          `**This comment has been temporarily removed for verification.**\n\n` +
          `To prove you're human, click the link below to see your verification code:\n\n` +
          `**[Click here to get your code](${captchaLink})**\n\n` +
          `Then reply to this comment with just the 6-character code.\n\n` +
          `This is a one-time check - once verified, all your future activity will go through automatically.`,
      });
      await notice.distinguish(true);
      await notice.approve();
      await markBotComment(redis, notice.id, username);
      await redis.hSet(pendingKey(username), { botCommentId: notice.id });
      await addToThread(redis, username, notice.id);
      console.log(`Left verification comment ${notice.id} for u/${username} (comment)`);
    } catch (e) {
      console.error(`Failed to leave verification comment on comment: ${e}`);
    }
  } else {
    // Already challenged - still reply with existing captcha link
    const token = simpleEncode(existingChallenge.code, username, CAPTCHA_SECRET_KEY, subredditName);
    const captchaLink = `${CAPTCHA_SERVER_URL}/c/${token}`;

    try {
      const notice = await reddit.submitComment({
        id: commentId,
        text:
          `**This comment has been temporarily removed for verification.**\n\n` +
          `You have a pending verification. **[Click here to get your code](${captchaLink})**\n\n` +
          `Reply to this comment with just the 6-character code.`,
      });
      await notice.distinguish(true);
      await notice.approve();
      await markBotComment(redis, notice.id, username);
      await addToThread(redis, username, notice.id);
    } catch (e) {
      console.error(`Failed to leave reminder comment: ${e}`);
    }
    console.log(`u/${username} already has pending challenge, reminded`);
  }

  // Now remove the comment
  try {
    const comment = await reddit.getCommentById(commentId);
    await comment.remove();
  } catch (e) {
    console.error(`Failed to remove comment ${commentId}: ${e}`);
    return;
  }

  const maxHeld = ((await context.settings.get("max-held-items")) as number) ?? 5;
  await holdContent(redis, username, commentId, maxHeld);
}

// --- Triggers ---
Devvit.addTrigger({
  event: "PostSubmit",
  onEvent: async (event, context) => {
    const post = event.post;
    const author = event.author;
    const subreddit = event.subreddit;
    if (!post || !author || !subreddit) return;

    const username = author.name;
    const subredditName = subreddit.name;
    if (!username || !subredditName) return;

    console.log(`PostSubmit: u/${username} in r/${subredditName}`);

    // Link spam detection (runs for all users including approved)
    if (!IGNORED_USERS.has(username)) {
      const text = post.title + (post.selftext ? "\n" + post.selftext : "");
      const spamDetected = await handleLinkDetection(context, username, text, "post", post.id, subredditName);
      if (spamDetected) return; // already handled
    }

    await handleNewPost(context, username, post.id, subredditName);
  },
});

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: async (event, context) => {
    const comment = event.comment;
    const author = event.author;
    const subreddit = event.subreddit;
    if (!comment || !author || !subreddit) return;

    const username = author.name;
    const subredditName = subreddit.name;
    if (!username || !subredditName) return;

    console.log(`CommentSubmit: u/${username} in r/${subredditName}, parentId: ${comment.parentId}`);

    // Link spam detection (runs for all users including approved, but not bot)
    if (!IGNORED_USERS.has(username)) {
      const spamDetected = await handleLinkDetection(context, username, comment.body, "comment", comment.id, subredditName, comment.postId);
      if (spamDetected) return; // already handled
    }

    await handleComment(context, username, comment.id, comment.body, comment.parentId, subredditName);
  },
});

// --- Process pending actions from dashboard ---
Devvit.configure({ redditAPI: true, redis: true, http: true });

// Poll Telegram for action messages (relay)
Devvit.addSchedulerJob({
  name: "process_actions",
  onRun: async (_, context) => {
    console.log("process_actions tick");
    const { reddit, subredditId, redis } = context;
    if (!subredditId) {
      console.log("no subredditId, skipping");
      return;
    }

    try {
      const sub = await reddit.getSubredditById(subredditId);
      if (!sub) {
        console.log("sub not found");
        return;
      }

      // Poll Telegram - no allowed_updates filter, get everything
      const tgResp = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_READER_TOKEN}/getUpdates?timeout=0`
      );
      console.log(`TG response status: ${tgResp.status}`);
      const bodyText = await tgResp.text();
      console.log(`TG response: ${bodyText.slice(0, 300)}`);
      const tgData = JSON.parse(bodyText) as { ok: boolean; result: Array<{ update_id: number; channel_post?: { text?: string } }> };
      if (!tgData.ok) return;
      console.log(`Got ${tgData.result.length} Telegram updates`);
      if (!tgData.result.length) return;
      for (const update of tgData.result) {
        console.log(`Update keys: ${Object.keys(update).join(",")}`);
        const msg = (update as any).channel_post?.text || (update as any).message?.text;
        if (!msg) {
          continue;
        }
        console.log(`Telegram msg: "${msg}"`);

        // Skip event messages (those are Devvit→Worker, not commands)
        if (msg.startsWith("EVT:") || msg.startsWith("✅")) {
          console.log(`  event message, skipping`);
          continue;
        }

        const parts = msg.split("|");
        if (parts.length < 3) {
          console.log(`  invalid format (${parts.length} parts), skipping`);
          continue;
        }
        const [action, actionSub, target, paramsJson] = parts;
        console.log(`  action=${action}, sub=${actionSub}, target=${target}, thisSub=${sub.name}`);

        if (actionSub !== sub.name) {
          console.log(`  wrong sub, skipping`);
          continue;
        }

        try {
          const params = paramsJson ? JSON.parse(paramsJson) : {};
          if (action === "ban") {
            await reddit.banUser({
              username: target,
              subredditName: sub.name,
              duration: params.duration || 0,
              reason: params.reason || "Banned via ScanSlop dashboard",
              note: "ScanSlop dashboard ban",
            });
            console.log(`Banned u/${target}`);
            await sendEvent(`EVT:ban|${sub.name}|${target}|${params.reason || "dashboard"}|${params.duration || 0}`);
          } else if (action === "approve") {
            await redis.set(approvedKey(target), "1");
            console.log(`Approved u/${target}`);
          } else if (action === "unban") {
            await sub.unbanUser(target);
            console.log(`Unbanned u/${target}`);
            await sendEvent(`EVT:unban|${sub.name}|${target}`);
          } else if (action === "revoke") {
            await redis.del(approvedKey(target));
            await redis.del(pendingKey(target));
            await redis.del(heldKey(target));
            console.log(`Revoked verification for u/${target}`);
          }

          // Send confirmation back to Telegram
          await fetch(`https://api.telegram.org/bot${TELEGRAM_READER_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHAT_ID,
              text: `✅ ${action} u/${target} in r/${actionSub} - done`,
            }),
          });
        } catch (e) {
          console.error(`Action failed: ${e}`);
        }

        // Confirm update so it's removed from Telegram's queue
        await fetch(`https://api.telegram.org/bot${TELEGRAM_READER_TOKEN}/getUpdates?offset=${update.update_id + 1}&timeout=0`);
      }
    } catch (e) {
      console.error(`process_actions error: ${e}`);
    }
  },
});

// --- Cleanup: delete bot verification comments older than 20 min ---
Devvit.addSchedulerJob({
  name: "cleanup_old_comments",
  onRun: async (_, context) => {
    const { redis, reddit } = context;
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour ago

    // Scan all botcomment keys
    // We track bot comments with botcomment:{commentId} -> username
    // We also need to find them - use a cleanup set
    try {
      const keys = await redis.zRange("cleanup:botcomments", 0, cutoff, { by: "score" });
      for (const item of keys) {
        const commentId = item.member;
        try {
          const comment = await reddit.getCommentById(commentId);
          if (comment.authorName === BOT_NAME) {
            await comment.delete();
            console.log(`Cleanup: deleted old verification comment ${commentId}`);
          }
        } catch {
          // already deleted or not found
        }
        await redis.zRem("cleanup:botcomments", [commentId]);
      }
    } catch (e) {
      console.error(`Cleanup error: ${e}`);
    }
  },
});

// --- App install/upgrade ---
Devvit.addTrigger({
  event: "AppInstall",
  onEvent: async (_, context) => {
    await context.scheduler.runJob({
      name: "cleanup_old_comments",
      cron: "*/5 * * * *",
    });
    await context.scheduler.runJob({
      name: "process_actions",
      cron: "* * * * *", // every minute
    });
    console.log("ScanSlop installed - jobs scheduled");
  },
});

Devvit.addTrigger({
  event: "AppUpgrade",
  onEvent: async (_, context) => {
    // Cancel existing jobs and reschedule
    try {
      const jobs = await context.scheduler.listJobs();
      for (const job of jobs) {
        if (job.name === "cleanup_old_comments" || job.name === "process_actions") {
          await context.scheduler.cancelJob(job.id);
        }
      }
    } catch {}
    await context.scheduler.runJob({ name: "cleanup_old_comments", cron: "*/5 * * * *" });
    await context.scheduler.runJob({ name: "process_actions", cron: "* * * * *" });
    console.log("ScanSlop upgraded - jobs rescheduled");
  },
});

// --- Mod menu ---
Devvit.addMenuItem({
  label: "Approve User (ScanSlop)",
  location: "post",
  forUserType: "moderator",
  onPress: async (event, context) => {
    const post = await context.reddit.getPostById(event.targetId);
    const username = post.authorName;
    if (!username) {
      context.ui.showToast("No author found");
      return;
    }
    await approveUser(context, username);
    context.ui.showToast(`u/${username} approved`);
  },
});

Devvit.addMenuItem({
  label: "Approve User (ScanSlop)",
  location: "comment",
  forUserType: "moderator",
  onPress: async (event, context) => {
    const comment = await context.reddit.getCommentById(event.targetId);
    const username = comment.authorName;
    if (!username) {
      context.ui.showToast("No author found");
      return;
    }
    await approveUser(context, username);
    context.ui.showToast(`u/${username} approved`);
  },
});

Devvit.addMenuItem({
  label: "ScanSlop Dashboard",
  location: "subreddit",
  forUserType: "moderator",
  onPress: async (_event, context) => {
    const sub = await context.reddit.getSubredditById(context.subredditId!);
    if (!sub) { context.ui.showToast("Could not find subreddit"); return; }
    const ts = Date.now();
    const key = await deriveDashboardKey(sub.name, ts);
    const url = `https://scanslop.com/dashboard?sub=${sub.name}&key=${key}&t=${ts}`;
    context.ui.showToast(`Dashboard: ${url}`);
    context.ui.navigateTo(url);
  },
});

export default Devvit;
