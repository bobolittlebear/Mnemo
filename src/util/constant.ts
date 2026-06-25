export const UNKNOWN_ERROR = '未知错误';
export const RENEW_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7*24小时，单位为毫秒
export const MAX_CHECK_LENGTH = 50;

export const SESSION_PREFIX = 'quick_note:session:'; // 记忆管理memory key的前缀
export const MAX_MESSAGE_PER_SESSION = 100;
export const SESSION_TTL_SECONDS = 60 * 60; // Redis TTL 以秒为单位，60分钟

export const TIMEOUT_MS = 100;

export const COOKIE_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 1 week
export const COOKIE_MEMORY_KEY_MAX_AGE = 24 * 60 * 60 * 1000; // 24 小时
