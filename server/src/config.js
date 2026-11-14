import 'dotenv/config';

const prod = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || (prod ? '' : 'dev-only-insecure-secret-change-me');
if (prod && jwtSecret.length < 32) throw new Error('Set JWT_SECRET (at least 32 random characters) in the environment.');

export const cfg = {
  port: +process.env.PORT || 5000,
  mongo: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/signalstack',

  groq: {
    key: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    rpm: Number(process.env.GROQ_RPM) || 10,
  },

  jwt: {
    secret: jwtSecret,
    expiresDays: +process.env.JWT_EXPIRES_DAYS || 7,
    allowRegister: process.env.ALLOW_REGISTRATION !== 'false', // when false, signup closes after the first account
  },

  tavilyKey: process.env.TAVILY_API_KEY || '',
  redditId: process.env.REDDIT_CLIENT_ID || '',
  newsRegion: process.env.NEWS_REGION || 'en-US:US',
  botName: 'SignalStackBot',
  ua: process.env.CRAWLER_USER_AGENT || 'SignalStackBot/1.0 (+https://example.com/signal-stack; contact: admin@example.com)',
  crawl: {
    hostDelayMs: process.env.CRAWL_HOST_DELAY_MS !== undefined ? +process.env.CRAWL_HOST_DELAY_MS : 2000,
    timeoutMs: 15000,
    maxBytes: 2_000_000,
    maxItemsPerSource: 15,
    maxArticleFetch: 5,
    lookbackDays: 45,
  },
    resend: {
    key: process.env.RESEND_API_KEY || '',
    from: process.env.RESEND_FROM || 'Signal Stack <onboarding@resend.dev>',
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: +process.env.SMTP_PORT || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
  },
};
