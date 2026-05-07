// Copy this file to config.ts and fill in your values.
// config.ts is gitignored.

export const CAPTCHA_SERVER_URL = "https://yourdomain.com";
export const CAPTCHA_SECRET_KEY = "your-shared-secret-key";

// Telegram relay (used for Worker <-> Devvit communication)
// Bot A is used by the Worker to send messages.
// Bot B (this token) is used by Devvit to read messages and send events.
// Both bots must be admins of the channel.
export const TELEGRAM_READER_TOKEN = "BOT_B_TOKEN_HERE";
export const TELEGRAM_CHAT_ID = "-100XXXXXXXXXX";
