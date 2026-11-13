import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

interface UserRecord {
  id: string;
  username: string;
  usernameLower: string;
  passwordHash: string;
  createdAt: number;
}

interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

interface LibraryGameRecord {
  id: string;
  userId: string;
  gameId: string;
  gameName: string;
  fileName: string;
  consoleId: string;
  consoleName: string;
  fileSize: number;
  addedAt: number;
  lastPlayedAt: number;
  storageProvider?: 'local' | 'terabox' | 'neon';
  teraboxPath?: string;
  teraboxFsId?: string;
  storageKey?: string;
}

interface TeraBoxAccountRecord {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  apiDomain: string;
  uploadDomain: string;
  domainCachedAt: number;
  teraboxUserId?: string;
  uname?: string;
  avatarUrl?: string;
  connectedAt: number;
}

interface AuthenticatedRequest extends Request {
  user?: UserRecord;
  sessionTokenHash?: string;
}

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.cwd(), '.retrohub-data');
const ROMS_DIR = path.join(DATA_DIR, 'roms');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const TERABOX_FILE = path.join(DATA_DIR, 'terabox.json');

const DATA_FILE_KEYS = new Map<string, string>([
  [path.resolve(USERS_FILE), 'users'],
  [path.resolve(SESSIONS_FILE), 'sessions'],
  [path.resolve(LIBRARY_FILE), 'library'],
  [path.resolve(TERABOX_FILE), 'terabox'],
]);
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const databasePool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 })
  : null;
databasePool?.on('error', (error: Error) => {
  console.error('Unexpected database connection error:', error.message);
});
const NEON_STORAGE_BUCKET = (process.env.RETROHUB_S3_BUCKET || 'retrohub-roms').trim();
let neonObjectClient: S3Client | null = null;
const MAX_NEON_STORAGE_BYTES = 4.5 * 1024 * 1024 * 1024;

const MAX_GAMES_PER_USER = 100;
const MAX_STORAGE_BYTES_PER_USER = 500 * 1024 * 1024; // development-only local fallback per user
const TERABOX_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB required by TeraBox superfile2

// Simple in-memory mutex chain for serialized JSON file mutations
let writeLock: Promise<void> = Promise.resolve();
function withDataLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = writeLock.then(() => Promise.resolve(fn()));
  writeLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

// Sliding window rate limiter for auth endpoints
const authRateMap = new Map<string, number[]>();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 120;

function checkAuthRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = (authRateMap.get(ip) ?? []).filter((t) => now - t < AUTH_WINDOW_MS);
  if (timestamps.length >= AUTH_MAX_ATTEMPTS) {
    res.status(429).json({
      error: 'Muitas tentativas de autenticação. Aguarde alguns minutos e tente novamente.',
    });
    return;
  }
  timestamps.push(now);
  authRateMap.set(ip, timestamps);
  next();
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ROMS_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]', 'utf8');
  if (!fs.existsSync(LIBRARY_FILE)) fs.writeFileSync(LIBRARY_FILE, '[]', 'utf8');
  if (!fs.existsSync(TERABOX_FILE)) fs.writeFileSync(TERABOX_FILE, '[]', 'utf8');
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

async function writeJsonAtomic(filePath: string, data: unknown) {
  const stateKey = DATA_FILE_KEYS.get(path.resolve(filePath));
  if (databasePool && stateKey) {
    await databasePool.query(
      `INSERT INTO public.retrohub_state (state_key, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (state_key)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [stateKey, JSON.stringify(data)]
    );
  }
  writeJsonFileAtomic(filePath, data);
}

async function initializeDatabasePersistence() {
  if (!databasePool) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_URL is required in production.');
    }
    return;
  }

  await databasePool.query('SELECT 1');
  await databasePool.query(`
    CREATE TABLE IF NOT EXISTS public.retrohub_state (
      state_key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  for (const [filePath, stateKey] of DATA_FILE_KEYS.entries()) {
    const result = await databasePool.query<{ data: unknown }>(
      'SELECT data FROM public.retrohub_state WHERE state_key = $1',
      [stateKey]
    );
    if (result.rows.length > 0) {
      writeJsonFileAtomic(filePath, result.rows[0].data);
    } else {
      const localData = readJson<unknown[]>(filePath, []);
      await databasePool.query(
        `INSERT INTO public.retrohub_state (state_key, data, updated_at)
         VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_key) DO NOTHING`,
        [stateKey, JSON.stringify(localData)]
      );
    }
  }
}

function getNeonObjectStorageClient(): S3Client | null {
  const endpoint = (process.env.AWS_ENDPOINT_URL_S3 || '').trim();
  const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  if (!neonObjectClient) {
    neonObjectClient = new S3Client({
      region: process.env.AWS_REGION || 'eu-central-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return neonObjectClient;
}

function buildNeonStorageKey(userId: string, gameId: string, fileName: string): string {
  const safeName = sanitizeTeraBoxFileName(fileName);
  return `users/${sanitizeId(userId)}/${sanitizeId(gameId)}/${crypto.randomUUID()}_${safeName}`;
}

async function deleteNeonStoredObject(storageKey?: string) {
  const client = getNeonObjectStorageClient();
  if (!client || !storageKey) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: NEON_STORAGE_BUCKET, Key: storageKey }));
  } catch {
    // Ignore remote deletion errors after metadata is removed.
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split(':');
    if (parts.length !== 2) return false;
    const [salt, hex] = parts;
    const derived = crypto.scryptSync(password, salt, 64);
    const storedBuf = Buffer.from(hex, 'hex');
    if (derived.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(derived, storedBuf);
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const rawVal = part.slice(idx + 1).trim();
      try {
        out[k] = decodeURIComponent(rawVal);
      } catch {
        out[k] = rawVal;
      }
    }
  }
  return out;
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const t = authHeader.slice(7).trim();
    if (t.length >= 16 && t.length <= 256) return t;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.retrohub_session) return cookies.retrohub_session;
  return null;
}

function sanitizeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function sanitizeLabel(input: string, maxLen = 140): string {
  return input
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .trim()
    .slice(0, maxLen);
}

function safeDecodeHeader(val: string | undefined): string {
  if (!val) return '';
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function resolveUserRomPath(userId: string, gameId: string): { userDir: string; romPath: string } {
  const safeUser = sanitizeId(userId);
  const safeGame = sanitizeId(gameId);
  const userDir = path.resolve(ROMS_DIR, safeUser);
  const romPath = path.resolve(userDir, `${safeGame}.rom`);
  if (!userDir.startsWith(path.resolve(ROMS_DIR) + path.sep)) {
    throw new Error('Caminho de usuário inválido.');
  }
  if (!romPath.startsWith(userDir + path.sep)) {
    throw new Error('Caminho de jogo inválido.');
  }
  return { userDir, romPath };
}

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function validateUsername(username: string): string | null {
  if (username.length < 2) return 'O nome da conta deve ter pelo menos 2 caracteres.';
  if (username.length > 40) return 'O nome da conta pode ter no máximo 40 caracteres.';
  if (/[\u0000-\u001F\u007F<>"'\\]/.test(username)) {
    return 'Remova caracteres inválidos (< > " \' \\) do nome da conta.';
  }
  return null;
}

function buildCookieHeader(req: Request, token: string, maxAgeSec: number): string {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const sameSite = isHttps ? 'SameSite=None; Secure' : 'SameSite=Lax';
  return `retrohub_session=${encodeURIComponent(token)}; Path=/; HttpOnly; ${sameSite}; Max-Age=${maxAgeSec}`;
}

// ==========================================
// TeraBox Open Platform Cloud Storage Engine
// ==========================================
function getTeraBoxConfig() {
  const clientId = (process.env.TERABOX_CLIENT_ID || '').trim();
  const clientSecret = (process.env.TERABOX_CLIENT_SECRET || '').trim();
  const privateSecret = (process.env.TERABOX_PRIVATE_SECRET || '').trim();
  const rawFolder = (process.env.TERABOX_APP_FOLDER || '/RetroHub').trim();
  const appFolder = ('/' + rawFolder.replace(/^\/+|\/+$/g, '')).replace(/\/+/g, '/') || '/RetroHub';
  return {
    configured: Boolean(clientId && clientSecret && privateSecret),
    clientId,
    clientSecret,
    privateSecret,
    appFolder,
  };
}

function teraboxComputeSign(
  clientId: string,
  timestampSec: number,
  clientSecret: string,
  privateSecret: string
): string {
  return crypto
    .createHash('md5')
    .update(`${clientId}_${timestampSec}_${clientSecret}_${privateSecret}`)
    .digest('hex');
}

function sanitizeTeraBoxFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]+/g, '_').slice(0, 120) || 'game.rom';
}

function normalizeTeraBoxHost(domain: string | undefined): string {
  const clean = (domain || 'www.terabox.com').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return clean || 'www.terabox.com';
}

const teraboxRefreshInflight = new Map<string, Promise<TeraBoxAccountRecord>>();

async function fetchTeraBoxTokenInfo(accessToken: string): Promise<{
  apiDomain: string;
  uploadDomain: string;
  teraboxUserId?: string;
}> {
  const form = new FormData();
  form.append('access_token', accessToken);
  const res = await fetch('https://www.terabox.com/oauth/tokeninfo', {
    method: 'POST',
    body: form,
  });
  const json = (await res.json()) as {
    errno?: number;
    data?: {
      api_domain?: string;
      upload_domain?: string;
      user_id?: string | number;
    };
  };
  return {
    apiDomain: normalizeTeraBoxHost(json.data?.api_domain),
    uploadDomain: normalizeTeraBoxHost(json.data?.upload_domain || json.data?.api_domain),
    teraboxUserId: json.data?.user_id !== undefined ? String(json.data.user_id) : undefined,
  };
}

async function fetchTeraBoxUserProfile(
  apiDomain: string,
  accessToken: string
): Promise<{ uname?: string; avatarUrl?: string; quotaTotal?: number; quotaUsed?: number }> {
  try {
    const [uRes, qRes] = await Promise.all([
      fetch(`https://${apiDomain}/openapi/uinfo?access_tokens=${encodeURIComponent(accessToken)}`),
      fetch(`https://${apiDomain}/openapi/api/quota?access_tokens=${encodeURIComponent(accessToken)}`),
    ]);
    const uJson = (await uRes.json()) as { uname?: string; avatar_url?: string };
    const qJson = (await qRes.json()) as { total?: number; used?: number };
    return {
      uname: typeof uJson.uname === 'string' ? uJson.uname : undefined,
      avatarUrl: typeof uJson.avatar_url === 'string' ? uJson.avatar_url : undefined,
      quotaTotal: typeof qJson.total === 'number' ? qJson.total : undefined,
      quotaUsed: typeof qJson.used === 'number' ? qJson.used : undefined,
    };
  } catch {
    return {};
  }
}

async function saveTeraBoxConnectionForUser(
  userId: string,
  tokens: { access_token: string; refresh_token: string; expires_in: number }
): Promise<TeraBoxAccountRecord> {
  const info = await fetchTeraBoxTokenInfo(tokens.access_token);
  const profile = await fetchTeraBoxUserProfile(info.apiDomain, tokens.access_token);
  const now = Date.now();
  const record: TeraBoxAccountRecord = {
    userId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + Math.max(60, Number(tokens.expires_in || 172800)) * 1000,
    apiDomain: info.apiDomain,
    uploadDomain: info.uploadDomain,
    domainCachedAt: now,
    teraboxUserId: info.teraboxUserId,
    uname: profile.uname,
    avatarUrl: profile.avatarUrl,
    connectedAt: now,
  };
  await withDataLock(async () => {
    const all = readJson<TeraBoxAccountRecord[]>(TERABOX_FILE, []).filter(
      (item) => item.userId !== userId
    );
    all.push(record);
    await writeJsonAtomic(TERABOX_FILE, all);
  });
  return record;
}

function getTeraBoxRecord(userId: string): TeraBoxAccountRecord | null {
  const all = readJson<TeraBoxAccountRecord[]>(TERABOX_FILE, []);
  return all.find((item) => item.userId === userId) ?? null;
}

async function ensureValidTeraBoxRecord(userId: string): Promise<TeraBoxAccountRecord> {
  const existing = teraboxRefreshInflight.get(userId);
  if (existing) return existing;

  const task = (async () => {
    const cfg = getTeraBoxConfig();
    if (!cfg.configured) {
      throw new Error('Credenciais do TeraBox não configuradas no servidor.');
    }
    let rec = getTeraBoxRecord(userId);
    if (!rec) {
      throw new Error('Sua conta do TeraBox ainda não está conectada.');
    }

    const now = Date.now();
    // Refresh access_token if expired or expiring within 5 minutes
    if (now > rec.expiresAt - 5 * 60 * 1000) {
      const ts = Math.floor(now / 1000);
      const sign = teraboxComputeSign(cfg.clientId, ts, cfg.clientSecret, cfg.privateSecret);
      const form = new FormData();
      form.append('client_id', cfg.clientId);
      form.append('client_secret', cfg.clientSecret);
      form.append('refresh_token', rec.refreshToken);
      form.append('timestamp', String(ts));
      form.append('sign', sign);

      const res = await fetch('https://www.terabox.com/oauth/refreshtoken', {
        method: 'POST',
        body: form,
      });
      const json = (await res.json()) as {
        errno?: number;
        errmsg?: string;
        data?: { access_token?: string; refresh_token?: string; expires_in?: number };
      };
      if (!json.data?.access_token || !json.data?.refresh_token) {
        throw new Error(
          'Sua sessão do TeraBox expirou. Clique em "Conectar TeraBox" novamente.'
        );
      }
      rec = await saveTeraBoxConnectionForUser(userId, {
        access_token: json.data.access_token,
        refresh_token: json.data.refresh_token,
        expires_in: json.data.expires_in ?? 172800,
      });
    } else if (now - rec.domainCachedAt > 50 * 60 * 1000) {
      // Refresh cached api_domain / upload_domain every ~50 minutes (doc recommendation < 1h)
      const info = await fetchTeraBoxTokenInfo(rec.accessToken);
      rec = {
        ...rec,
        apiDomain: info.apiDomain,
        uploadDomain: info.uploadDomain,
        domainCachedAt: now,
      };
      await withDataLock(async () => {
        const all = readJson<TeraBoxAccountRecord[]>(TERABOX_FILE, []).map((item) =>
          item.userId === userId ? rec! : item
        );
        await writeJsonAtomic(TERABOX_FILE, all);
      });
    }

    return rec;
  })();

  teraboxRefreshInflight.set(userId, task);
  try {
    return await task;
  } finally {
    teraboxRefreshInflight.delete(userId);
  }
}

async function teraboxUploadRomBuffer(
  userId: string,
  gameId: string,
  fileName: string,
  buf: Buffer
): Promise<{ fsId: string; remotePath: string }> {
  const rec = await ensureValidTeraBoxRecord(userId);
  const cfg = getTeraBoxConfig();
  const safeName = sanitizeTeraBoxFileName(fileName);
  const remotePath = `${cfg.appFolder}/${sanitizeId(gameId)}_${safeName}`;

  // Split into 4 MiB chunks as required by TeraBox /rest/2.0/pcs/superfile2
  const chunks: Buffer[] = [];
  const blockList: string[] = [];
  for (let offset = 0; offset < buf.length; offset += TERABOX_CHUNK_BYTES) {
    const slice = buf.subarray(offset, Math.min(buf.length, offset + TERABOX_CHUNK_BYTES));
    chunks.push(slice);
    blockList.push(crypto.createHash('md5').update(slice).digest('hex'));
  }

  // Step 1: /openapi/api/precreate
  const preParams = new URLSearchParams({
    path: remotePath,
    autoinit: '1',
    size: String(buf.length),
    block_list: JSON.stringify(blockList),
  });
  const preRes = await fetch(
    `https://${rec.apiDomain}/openapi/api/precreate?access_tokens=${encodeURIComponent(
      rec.accessToken
    )}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: preParams.toString(),
    }
  );
  const preJson = (await preRes.json()) as {
    errno?: number;
    errmsg?: string;
    uploadid?: string;
    block_list?: number[];
    return_type?: number;
  };
  if (preJson.errno && preJson.errno !== 0) {
    throw new Error(`TeraBox precreate falhou (código ${preJson.errno}): ${preJson.errmsg || ''}`);
  }
  const uploadId = preJson.uploadid || '';

  // Step 2: Upload needed chunks to upload_domain/rest/2.0/pcs/superfile2
  const neededIndices =
    Array.isArray(preJson.block_list) && preJson.block_list.length > 0
      ? preJson.block_list
      : chunks.map((_, idx) => idx);

  if (preJson.return_type !== 2 && uploadId) {
    for (const partseq of neededIndices) {
      const chunk = chunks[partseq];
      if (!chunk) continue;
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(chunk)]), safeName);
      const upUrl =
        `https://${rec.uploadDomain}/rest/2.0/pcs/superfile2?method=upload&app_id=250528` +
        `&path=${encodeURIComponent(remotePath)}` +
        `&uploadid=${encodeURIComponent(uploadId)}` +
        `&partseq=${partseq}` +
        `&access_tokens=${encodeURIComponent(rec.accessToken)}`;
      const upRes = await fetch(upUrl, { method: 'POST', body: form });
      const upJson = (await upRes.json()) as { error_code?: number; error_msg?: string; md5?: string };
      if (upJson.error_code) {
        throw new Error(
          `TeraBox upload chunk ${partseq} falhou (${upJson.error_code}): ${upJson.error_msg || ''}`
        );
      }
    }
  }

  // Step 3: Finalize file via /openapi/api/create
  const createParams = new URLSearchParams({
    path: remotePath,
    size: String(buf.length),
    uploadid: uploadId,
    block_list: JSON.stringify(blockList),
    rtype: '3',
  });
  const createRes = await fetch(
    `https://${rec.apiDomain}/openapi/api/create?access_tokens=${encodeURIComponent(
      rec.accessToken
    )}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: createParams.toString(),
    }
  );
  const createJson = (await createRes.json()) as {
    errno?: number;
    errmsg?: string;
    fs_id?: number | string;
    path?: string;
  };
  if (createJson.errno && createJson.errno !== 0) {
    throw new Error(`TeraBox create falhou (código ${createJson.errno}): ${createJson.errmsg || ''}`);
  }

  return {
    fsId: createJson.fs_id !== undefined ? String(createJson.fs_id) : '',
    remotePath: createJson.path || remotePath,
  };
}

async function teraboxDownloadRomResponse(
  userId: string,
  game: LibraryGameRecord
): Promise<globalThis.Response> {
  const rec = await ensureValidTeraBoxRecord(userId);
  let dlink = '';

  if (game.teraboxFsId) {
    const dlUrl =
      `https://${rec.apiDomain}/openapi/api/download?access_tokens=${encodeURIComponent(
        rec.accessToken
      )}&fidlist=${encodeURIComponent(`[${game.teraboxFsId}]`)}&type=dlink`;
    const metaRes = await fetch(dlUrl);
    const metaJson = (await metaRes.json()) as {
      errno?: number;
      dlink?: Array<{ fs_id?: string | number; dlink?: string }>;
    };
    if (Array.isArray(metaJson.dlink) && metaJson.dlink[0]?.dlink) {
      dlink = metaJson.dlink[0].dlink;
    }
  }

  if (!dlink && game.teraboxPath) {
    const fmUrl =
      `https://${rec.apiDomain}/openapi/api/filemetas?access_tokens=${encodeURIComponent(
        rec.accessToken
      )}&target=${encodeURIComponent(JSON.stringify([game.teraboxPath]))}&dlink=1`;
    const fmRes = await fetch(fmUrl);
    const fmJson = (await fmRes.json()) as {
      errno?: number;
      info?: Array<{ dlink?: string }>;
    };
    if (Array.isArray(fmJson.info) && fmJson.info[0]?.dlink) {
      dlink = fmJson.info[0].dlink;
    }
  }

  if (!dlink) {
    throw new Error('Arquivo não encontrado na sua conta TeraBox.');
  }

  const finalUrl = dlink.includes('access_tokens=')
    ? dlink
    : `${dlink}${dlink.includes('?') ? '&' : '?'}access_tokens=${encodeURIComponent(
        rec.accessToken
      )}`;

  const fileRes = await fetch(finalUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!fileRes.ok || !fileRes.body) {
    throw new Error(`Falha ao baixar ROM do TeraBox (HTTP ${fileRes.status}).`);
  }
  return fileRes;
}

async function teraboxDeleteFileBestEffort(userId: string, remotePath?: string): Promise<void> {
  if (!remotePath) return;
  try {
    const rec = await ensureValidTeraBoxRecord(userId);
    const params = new URLSearchParams({
      filelist: JSON.stringify([remotePath]),
    });
    await fetch(
      `https://${rec.apiDomain}/openapi/api/filemanager?access_tokens=${encodeURIComponent(
        rec.accessToken
      )}&opera=delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      }
    );
  } catch {
    // Ignore remote deletion errors if token expired or file was already removed
  }
}

async function startServer() {
  ensureStorage();
  await initializeDatabasePersistence();
  if (process.env.NODE_ENV === 'production' && !getNeonObjectStorageClient()) {
    throw new Error('Neon Object Storage credentials are required in production.');
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Baseline security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '512kb' }));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Formato de dados inválido na requisição.' });
      return;
    }
    next(err);
  });

  const requireAuth = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ error: 'Autenticação necessária.' });
      return;
    }
    const tokenHash = hashToken(token);
    const sessions = readJson<SessionRecord[]>(SESSIONS_FILE, []);
    const now = Date.now();
    const session = sessions.find((s) => s.tokenHash === tokenHash && s.expiresAt > now);
    if (!session) {
      res.status(401).json({ error: 'Sessão expirada ou inválida. Faça login novamente.' });
      return;
    }
    const users = readJson<UserRecord[]>(USERS_FILE, []);
    const user = users.find((u) => u.id === session.userId);
    if (!user) {
      res.status(401).json({ error: 'Conta não encontrada.' });
      return;
    }
    req.user = user;
    req.sessionTokenHash = tokenHash;
    next();
  };

  // Check username uniqueness in real time
  app.get('/api/auth/check-username', (req: Request, res: Response) => {
    const raw = String(req.query.username || '');
    const username = normalizeUsername(raw);
    const validationErr = validateUsername(username);
    if (validationErr) {
      res.json({ available: false, reason: validationErr });
      return;
    }
    const users = readJson<UserRecord[]>(USERS_FILE, []);
    const lower = username.toLocaleLowerCase('pt-BR');
    const exists = users.some((u) => u.usernameLower === lower);
    if (exists) {
      res.json({
        available: false,
        reason: 'Este nome já está sendo usado por outra conta. Escolha outro.',
      });
      return;
    }
    res.json({ available: true });
  });

  // Register account (unique username + password)
  app.post('/api/auth/register', checkAuthRateLimit, async (req: Request, res: Response) => {
    const username = normalizeUsername(String(req.body?.username || ''));
    const password = String(req.body?.password || '');

    const usernameErr = validateUsername(username);
    if (usernameErr) {
      res.status(400).json({ error: usernameErr });
      return;
    }
    if (password.length < 4 || password.length > 128) {
      res.status(400).json({ error: 'A senha deve ter entre 4 e 128 caracteres.' });
      return;
    }

    const result = await withDataLock(async () => {
      const users = readJson<UserRecord[]>(USERS_FILE, []);
      const usernameLower = username.toLocaleLowerCase('pt-BR');
      if (users.some((u) => u.usernameLower === usernameLower)) {
        return { conflict: true as const };
      }

      const newUser: UserRecord = {
        id: crypto.randomUUID(),
        username,
        usernameLower,
        passwordHash: hashPassword(password),
        createdAt: Date.now(),
      };
      users.push(newUser);
      await writeJsonAtomic(USERS_FILE, users);

      const token = crypto.randomBytes(32).toString('hex');
      const sessions = readJson<SessionRecord[]>(SESSIONS_FILE, []).filter(
        (s) => typeof s.tokenHash === 'string' && s.tokenHash.length === 64 && s.expiresAt > Date.now()
      );
      sessions.push({
        tokenHash: hashToken(token),
        userId: newUser.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
      });
      await writeJsonAtomic(SESSIONS_FILE, sessions);

      return { conflict: false as const, newUser, token };
    });

    if (result.conflict) {
      res.status(409).json({
        error: 'Este nome de conta já está em uso. Ninguém pode criar uma conta com nome igual.',
      });
      return;
    }

    res.setHeader('Set-Cookie', buildCookieHeader(req, result.token, 60 * 60 * 24 * 30));
    res.status(201).json({
      token: result.token,
      user: {
        id: result.newUser.id,
        username: result.newUser.username,
        createdAt: result.newUser.createdAt,
      },
    });
  });

  // Login
  app.post('/api/auth/login', checkAuthRateLimit, async (req: Request, res: Response) => {
    const username = normalizeUsername(String(req.body?.username || ''));
    const password = String(req.body?.password || '');
    if (!username || !password) {
      res.status(400).json({ error: 'Informe o nome da conta e a senha.' });
      return;
    }

    const users = readJson<UserRecord[]>(USERS_FILE, []);
    const user = users.find((u) => u.usernameLower === username.toLocaleLowerCase('pt-BR'));
    if (!user || !verifyPassword(password, user.passwordHash)) {
      res.status(401).json({ error: 'Nome da conta ou senha incorretos.' });
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    await withDataLock(async () => {
      const sessions = readJson<SessionRecord[]>(SESSIONS_FILE, []).filter(
        (s) => typeof s.tokenHash === 'string' && s.tokenHash.length === 64 && s.expiresAt > Date.now()
      );
      sessions.push({
        tokenHash: hashToken(token),
        userId: user.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30,
      });
      await writeJsonAtomic(SESSIONS_FILE, sessions);
    });

    res.setHeader('Set-Cookie', buildCookieHeader(req, token, 60 * 60 * 24 * 30));
    res.json({
      token,
      user: { id: user.id, username: user.username, createdAt: user.createdAt },
    });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    res.json({
      user: {
        id: req.user!.id,
        username: req.user!.username,
        createdAt: req.user!.createdAt,
      },
    });
  });

  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    const token = extractToken(req);
    if (token) {
      const tHash = hashToken(token);
      await withDataLock(async () => {
        const sessions = readJson<SessionRecord[]>(SESSIONS_FILE, []).filter(
          (s) => s.tokenHash !== tHash
        );
        await writeJsonAtomic(SESSIONS_FILE, sessions);
      });
    }
    res.setHeader('Set-Cookie', buildCookieHeader(req, '', 0));
    res.json({ ok: true });
  });

  // ==========================================
  // TeraBox OAuth & Cloud Sync Routes
  // ==========================================
  app.get('/api/terabox/status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const cfg = getTeraBoxConfig();
    const rec = getTeraBoxRecord(req.user!.id);
    if (!cfg.configured || !rec) {
      res.json({
        configured: cfg.configured,
        connected: false,
        clientId: cfg.configured ? cfg.clientId : null,
        appFolder: cfg.appFolder,
      });
      return;
    }

    try {
      const valid = await ensureValidTeraBoxRecord(req.user!.id);
      const profile = await fetchTeraBoxUserProfile(valid.apiDomain, valid.accessToken);
      res.json({
        configured: true,
        connected: true,
        clientId: cfg.clientId,
        appFolder: cfg.appFolder,
        account: {
          uname: profile.uname || valid.uname || 'Conta TeraBox',
          avatarUrl: profile.avatarUrl || valid.avatarUrl,
          quotaTotal: profile.quotaTotal,
          quotaUsed: profile.quotaUsed,
        },
      });
    } catch {
      res.json({
        configured: true,
        connected: false,
        clientId: cfg.clientId,
        appFolder: cfg.appFolder,
      });
    }
  });

  // Exchange authorization code from TeraBox outside/login iframe postMessage
  app.post('/api/terabox/exchange-code', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const cfg = getTeraBoxConfig();
    if (!cfg.configured) {
      res.status(503).json({
        error: 'O servidor ainda não tem TERABOX_CLIENT_ID / TERABOX_CLIENT_SECRET / TERABOX_PRIVATE_SECRET configurados.',
      });
      return;
    }
    const code = String(req.body?.code || '').trim();
    if (!code) {
      res.status(400).json({ error: 'Código de autorização TeraBox ausente.' });
      return;
    }

    const ts = Math.floor(Date.now() / 1000);
    const sign = teraboxComputeSign(cfg.clientId, ts, cfg.clientSecret, cfg.privateSecret);
    const form = new FormData();
    form.append('client_id', cfg.clientId);
    form.append('client_secret', cfg.clientSecret);
    form.append('grant_type', 'authorization_code');
    form.append('code', code);
    form.append('timestamp', String(ts));
    form.append('sign', sign);

    try {
      const tbRes = await fetch('https://www.terabox.com/oauth/gettoken', {
        method: 'POST',
        body: form,
      });
      const tbJson = (await tbRes.json()) as {
        errno?: number;
        errmsg?: string;
        data?: { access_token?: string; refresh_token?: string; expires_in?: number };
      };
      if (!tbJson.data?.access_token || !tbJson.data?.refresh_token) {
        res.status(400).json({
          error: tbJson.errmsg || `Não foi possível validar o login TeraBox (código ${tbJson.errno ?? 'desconhecido'}).`,
        });
        return;
      }

      const saved = await saveTeraBoxConnectionForUser(req.user!.id, {
        access_token: tbJson.data.access_token,
        refresh_token: tbJson.data.refresh_token,
        expires_in: tbJson.data.expires_in ?? 172800,
      });
      res.json({
        connected: true,
        uname: saved.uname || 'Conta TeraBox',
      });
    } catch {
      res.status(502).json({ error: 'Falha ao comunicar com os servidores de login do TeraBox.' });
    }
  });

  // Device Code QR Flow (works great on mobile & desktop with TeraBox App)
  app.post('/api/terabox/device-code', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
    const cfg = getTeraBoxConfig();
    if (!cfg.configured) {
      res.status(503).json({
        error: 'Credenciais TeraBox ainda não configuradas no ambiente do servidor.',
      });
      return;
    }
    try {
      const tbRes = await fetch(
        `https://www.terabox.com/oauth/devicecode?client_id=${encodeURIComponent(cfg.clientId)}`
      );
      const tbJson = (await tbRes.json()) as {
        errno?: number;
        errmsg?: string;
        data?: {
          device_code?: string;
          qrcode_url?: string;
          expires_in?: number;
          interval?: number;
        };
      };
      if (!tbJson.data?.device_code || !tbJson.data?.qrcode_url) {
        res.status(502).json({ error: tbJson.errmsg || 'Erro ao gerar QR Code do TeraBox.' });
        return;
      }
      res.json({
        deviceCode: tbJson.data.device_code,
        qrcodeUrl: tbJson.data.qrcode_url,
        expiresIn: tbJson.data.expires_in ?? 300,
        interval: tbJson.data.interval ?? 2,
      });
    } catch {
      res.status(502).json({ error: 'Falha ao conectar com o TeraBox para gerar QR Code.' });
    }
  });

  app.post('/api/terabox/device-poll', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const cfg = getTeraBoxConfig();
    if (!cfg.configured) {
      res.status(503).json({ error: 'TeraBox não configurado no servidor.' });
      return;
    }
    const deviceCode = String(req.body?.deviceCode || '').trim();
    if (!deviceCode) {
      res.status(400).json({ error: 'deviceCode ausente.' });
      return;
    }

    const ts = Math.floor(Date.now() / 1000);
    const sign = teraboxComputeSign(cfg.clientId, ts, cfg.clientSecret, cfg.privateSecret);
    const form = new FormData();
    form.append('client_id', cfg.clientId);
    form.append('client_secret', cfg.clientSecret);
    form.append('grant_type', 'device_code');
    form.append('code', deviceCode);
    form.append('timestamp', String(ts));
    form.append('sign', sign);

    try {
      const tbRes = await fetch('https://www.terabox.com/oauth/gettoken', {
        method: 'POST',
        body: form,
      });
      const tbJson = (await tbRes.json()) as {
        errno?: number;
        errmsg?: string;
        data?: { access_token?: string; refresh_token?: string; expires_in?: number };
      };
      if (tbJson.data?.access_token && tbJson.data?.refresh_token) {
        const saved = await saveTeraBoxConnectionForUser(req.user!.id, {
          access_token: tbJson.data.access_token,
          refresh_token: tbJson.data.refresh_token,
          expires_in: tbJson.data.expires_in ?? 172800,
        });
        res.json({ status: 'connected', uname: saved.uname || 'Conta TeraBox' });
        return;
      }
      // 400001 = user hasn't authorized yet in TeraBox app
      if (tbJson.errno === 400001) {
        res.json({ status: 'pending' });
        return;
      }
      res.status(400).json({
        status: 'error',
        error: tbJson.errmsg || `QR Code expirado ou inválido (código ${tbJson.errno ?? 0}).`,
      });
    } catch {
      res.json({ status: 'pending' });
    }
  });

  app.post('/api/terabox/disconnect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    await withDataLock(async () => {
      const all = readJson<TeraBoxAccountRecord[]>(TERABOX_FILE, []).filter(
        (item) => item.userId !== req.user!.id
      );
      await writeJsonAtomic(TERABOX_FILE, all);
    });
    res.json({ ok: true });
  });

  app.post('/api/terabox/migrate-local', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
      await ensureValidTeraBoxRecord(req.user!.id);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Conecte sua conta TeraBox primeiro.',
      });
      return;
    }

    const all = readJson<LibraryGameRecord[]>(LIBRARY_FILE, []);
    const localGames = all.filter(
      (g) => g.userId === req.user!.id && g.storageProvider !== 'terabox'
    );

    let migratedCount = 0;
    for (const game of localGames) {
      try {
        const { romPath } = resolveUserRomPath(req.user!.id, game.gameId);
        if (!fs.existsSync(romPath)) continue;
        const buf = fs.readFileSync(romPath);
        const uploaded = await teraboxUploadRomBuffer(
          req.user!.id,
          game.gameId,
          game.fileName,
          buf
        );
        await withDataLock(async () => {
          const current = readJson<LibraryGameRecord[]>(LIBRARY_FILE, []);
          const idx = current.findIndex(
            (x) => x.userId === req.user!.id && x.gameId === game.gameId
          );
          if (idx >= 0) {
            current[idx] = {
              ...current[idx],
              storageProvider: 'terabox',
              teraboxPath: uploaded.remotePath,
              teraboxFsId: uploaded.fsId,
            };
            await writeJsonAtomic(LIBRARY_FILE, current);
          }
        });
        try {
          fs.unlinkSync(romPath);
        } catch {
          // ignore
        }
        migratedCount++;
      } catch {
        // continue migrating remaining files
      }
    }

    res.json({ migratedCount });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, service: 'RetroHub' });
  });

  app.get('/api/storage/status', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
    const databaseConfigured = Boolean(databasePool);
    const objectStorageConfigured = Boolean(getNeonObjectStorageClient());
    res.json({
      configured: databaseConfigured && objectStorageConfigured,
      database: databaseConfigured ? 'Neon Postgres' : 'not-configured',
      files: objectStorageConfigured ? 'Neon Object Storage' : 'not-configured',
      bucket: objectStorageConfigured ? NEON_STORAGE_BUCKET : null,
    });
  });

  // Cloud Game Library. New uploads use the private Neon Object Storage bucket.
  app.get('/api/library', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const all = readJson<LibraryGameRecord[]>(LIBRARY_FILE, []);
    const mine = all
      .filter((item) => item.userId === req.user!.id)
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
    res.json({ games: mine });
  });

  app.post(
    '/api/library',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: '250mb' }),
    async (req: AuthenticatedRequest, res: Response) => {
      const gameId = sanitizeId(String(req.headers['x-game-id'] || ''));
      const gameName = sanitizeLabel(safeDecodeHeader(String(req.headers['x-game-name'] || '')));
      const rawFileName = sanitizeLabel(safeDecodeHeader(String(req.headers['x-file-name'] || '')));
      const fileName = path.basename(rawFileName.replace(/\\/g, '/')).replace(/^\.+/, '') || 'rom.bin';
      const consoleId = sanitizeId(String(req.headers['x-console-id'] || ''));
      const consoleName = sanitizeLabel(
        safeDecodeHeader(String(req.headers['x-console-name'] || ''))
      );

      if (!gameId || !fileName || !consoleId || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'Dados inválidos ao salvar jogo na conta.' });
        return;
      }

      const objectStore = getNeonObjectStorageClient();
      if (objectStore) {
        const currentStoredBytes = await withDataLock(() =>
          readJson<LibraryGameRecord[]>(LIBRARY_FILE, [])
            .filter((item) => item.storageProvider === 'neon' && !(item.userId === req.user!.id && item.gameId === gameId))
            .reduce((sum, item) => sum + item.fileSize, 0)
        );
        if (currentStoredBytes + req.body.length > MAX_NEON_STORAGE_BYTES) {
          res.status(413).json({ error: 'O limite de armazenamento configurado para a nuvem RetroHub foi atingido. Remove ficheiros antigos para libertar espaço.' });
          return;
        }
        const storageKey = buildNeonStorageKey(req.user!.id, gameId, fileName);
        try {
          await objectStore.send(
            new PutObjectCommand({
              Bucket: NEON_STORAGE_BUCKET,
              Key: storageKey,
              Body: req.body,
              ContentType: 'application/octet-stream',
            })
          );

          const saved = await withDataLock(async () => {
            const all = readJson<LibraryGameRecord[]>(LIBRARY_FILE, []);
            const existingIdx = all.findIndex(
              (g) => g.userId === req.user!.id && g.gameId === gameId
            );
            const previousStorageKey =
              existingIdx >= 0 && all[existingIdx].storageProvider === 'neon'
                ? all[existingIdx].storageKey
                : undefined;
            const now = Date.now();
            const record: LibraryGameRecord = {
              id: existingIdx >= 0 ? all[existingIdx].id : crypto.randomUUID(),
              userId: req.user!.id,
              gameId,
              gameName: gameName || fileName,
              fileName,
              consoleId,
              consoleName: consoleName || consoleId,
              fileSize: req.body.length,
              addedAt: existingIdx >= 0 ? all[existingIdx].addedAt : now,
              lastPlayedAt: now,
              storageProvider: 'neon',
              storageKey,
            };
            if (existingIdx >= 0) all[existingIdx] = record;
            else all.push(record);
            await writeJsonAtomic(LIBRARY_FILE, all);
            return { record, previousStorageKey };
          });

          if (saved.previousStorageKey && saved.previousStorageKey !== storageKey) {
            await deleteNeonStoredObject(saved.previousStorageKey);
          }
          try {
            const { romPath } = resolveUserRomPath(req.user!.id, gameId);
            if (fs.existsSync(romPath)) fs.unlinkSync(romPath);
          } catch {
            // Ignore stale local development copies.
          }
          res.status(201).json({ game: saved.record });
          return;
        } catch (err) {
          res.status(502).json({
            error:
              err instanceof Error
                ? `Não foi possível guardar o ficheiro na nuvem RetroHub: ${err.message}`
                : 'Falha ao enviar o ficheiro para o armazenamento na nuvem.',
          });
          return;
        }
      }

      if (process.env.NODE_ENV === 'production') {
        res.status(503).json({
          error: 'O armazenamento na nuvem ainda não está configurado. O ficheiro não foi guardado.',
        });
        return;
      }

      const saveRes = await withDataLock(async () => {
        const all = readJson<LibraryGameRecord[]>(LIBRARY_FILE, []);
        const userGames = all.filter((g) => g.userId === req.user!.id);
        const existingIdx = all.findIndex(
          (g) => g.userId === req.user!.id && g.gameId === gameId
        );

        const currentTotalBytes = userGames.reduce(
          (sum, g) =>
            g.gameId === gameId || g.storageProvider === 'terabox' ? sum : sum + g.fileSize,
          0
        );
        if (existingIdx < 0 && userGames.length >= MAX_GAMES_PER_USER) {
          return { error: `Limite de ${MAX_GAMES_PER_USER} jogos salvos na conta atingido.` };
        }
        if (currentTotalBytes + req.body.length > MAX_STORAGE_BYTES_PER_USER) {
          return { error: 'Limite de armazenamento local (500 MB) excedido. Conecte o TeraBox para 1 TB grátis.' };
        }

        const { userDir, romPath } = resolveUserRomPath(req.user!.id, gameId);
        fs.mkdirSync(userDir, { recursive: true });
        const tmpRomPath = `${romPath}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(tmpRomPath, req.body);
        fs.renameSync(tmpRomPath, romPath);

        const now = Date.now();
        const record: LibraryGameRecord = {
          id: existingIdx >= 0 ? all[existingIdx].id : crypto.randomUUID(),
          userId: req.user!.id,
          gameId,
          gameName: gameName || fileName,
          fileName,
          consoleId,
          consoleName: consoleName || consoleId,
          fileSize: req.body.length,
          addedAt: existingIdx >= 0 ? all[existingIdx].addedAt : now,
          lastPlayedAt: now,
          storageProvider: 'local',
        };

        if (existingIdx >= 0) {
          all[existingIdx] = record;
        } else {
          all.push(record);
        }
        await writeJsonAtomic(LIBRARY_FILE, all);
        return { record };
      });

      if ('error' in saveRes) {
        res.status(413).json({ error: saveRes.error });
        return;
      }

      res.status(201).json({ game: saveRes.record });
    }
  );

  app.get('/api/library/:gameId/rom', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const gameId = sanitizeId(String(req.params.gameId || ''));
    let romPath = '';
    try {
      romPath = resolveUserRomPath(req.user!.id, gameId).romPath;
    } catch {
      res.status(400).json({ error: 'Identificador inválido.' });
      return;
    }

    const record = await withDataLock(async () => {
      const all = readJson<LibraryGameRecord[]>(LIBRARY_FILE, []);
      const found = all.find((g) => g.userId === req.user!.id && g.gameId === gameId);
      if (found) {
        found.lastPlayedAt = Date.now();
        await writeJsonAtomic(LIBRARY_FILE, all);
      }
      return found ?? null;
    });

    if (!record) {
      res.status(404).json({ error: 'Jogo não encontrado na sua biblioteca.' });
      return;
    }

    if (record.storageProvider === 'neon') {
      try {
        const objectStore = getNeonObjectStorageClient();
        if (!objectStore || !record.storageKey) {
          throw new Error('O armazenamento na nuvem não está configurado ou a referência do ficheiro está em falta.');
        }
        const stored = await objectStore.send(
          new GetObjectCommand({ Bucket: NEON_STORAGE_BUCKET, Key: record.storageKey })
        );
        const body = stored.Body as import('node:stream').Readable | undefined;
        if (!body || typeof body.pipe !== 'function') {
          throw new Error('O armazenamento não devolveu um ficheiro válido.');
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(record.fileSize));
        res.setHeader('X-File-Name', encodeURIComponent(record.fileName));
        body.pipe(res);
        return;
      } catch (err) {
        res.status(502).json({
          error: err instanceof Error ? err.message : 'Erro ao descarregar o ficheiro da nuvem.',
        });
        return;
      }
    }

    if (record.storageProvider === 'terabox') {
      try {
        const tbFileRes = await teraboxDownloadRomResponse(req.user!.id, record);
        const arrayBuf = await tbFileRes.arrayBuffer();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-File-Name', encodeURIComponent(record.fileName));
        res.send(Buffer.from(arrayBuf));
        return;
      } catch (err) {
        res.status(502).json({
          error:
            err instanceof Error
              ? err.message
              : 'Erro ao baixar jogo do seu TeraBox. Verifique a conexão com o TeraBox.',
        });
        return;
      }
    }

    if (!fs.existsSync(romPath)) {
      res.status(404).json({ error: 'Arquivo do jogo não encontrado no armazenamento.' });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-File-Name', encodeURIComponent(record.fileName));
    fs.createReadStream(romPath).pipe(res);
  });

  app.delete('/api/library/:gameId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const gameId = sanitizeId(String(req.params.gameId || ''));
    let romPath = '';
    try {
      romPath = resolveUserRomPath(req.user!.id, gameId).romPath;
    } catch {
      res.status(400).json({ error: 'Identificador inválido.' });
      return;
    }

    const removedRecord = await withDataLock(async () => {
      const all = readJson<LibraryGameRecord[]>(LIBRARY_FILE, []);
      const target = all.find((g) => g.userId === req.user!.id && g.gameId === gameId);
      const next = all.filter((g) => !(g.userId === req.user!.id && g.gameId === gameId));
      await writeJsonAtomic(LIBRARY_FILE, next);
      if (fs.existsSync(romPath)) {
        fs.unlinkSync(romPath);
      }
      return target ?? null;
    });

    if (removedRecord?.storageProvider === 'neon') {
      await deleteNeonStoredObject(removedRecord.storageKey);
    } else if (removedRecord?.storageProvider === 'terabox') {
      await teraboxDeleteFileBestEffort(req.user!.id, removedRecord.teraboxPath);
    }

    res.json({ ok: true });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RetroHub server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start RetroHub server:', err);
  process.exit(1);
});
