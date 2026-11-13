export interface AuthUser {
  id: string;
  username: string;
  createdAt: number;
}

export interface LibraryGameItem {
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
}

export interface TeraBoxStatus {
  configured: boolean;
  connected: boolean;
  clientId: string | null;
  appFolder?: string;
  account?: {
    uname?: string;
    avatarUrl?: string;
    quotaTotal?: number;
    quotaUsed?: number;
  };
}

export interface TeraBoxDeviceCodeInfo {
  deviceCode: string;
  qrcodeUrl: string;
  expiresIn: number;
  interval: number;
}

const TOKEN_STORAGE_KEY = 'retrohub_auth_token';
let memoryAuthToken: string | null = null;

export function getStoredAuthToken(): string | null {
  if (memoryAuthToken) return memoryAuthToken;
  try {
    const ls = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (ls) {
      memoryAuthToken = ls;
      return ls;
    }
  } catch {
    // ignore restricted storage in private/iframe browsers
  }
  try {
    const ss = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (ss) {
      memoryAuthToken = ss;
      return ss;
    }
  } catch {
    // ignore
  }
  return null;
}

export function setStoredAuthToken(token: string | null) {
  memoryAuthToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getStoredAuthToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

async function readJsonSafe(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function checkUsernameAvailability(
  username: string
): Promise<{ available?: boolean; reason?: string }> {
  try {
    const res = await fetch(
      `/api/auth/check-username?username=${encodeURIComponent(username)}`,
      { credentials: 'include' }
    );
    if (!res.ok) return {};
    return (await readJsonSafe(res)) as { available?: boolean; reason?: string };
  } catch {
    return {};
  }
}

export async function registerAccount(
  username: string,
  password: string
): Promise<AuthUser> {
  let res: Response;
  try {
    res = await fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : 'Não foi possível criar a conta.'
    );
  }
  if (typeof data.token === 'string') setStoredAuthToken(data.token);
  return data.user as AuthUser;
}

export async function loginAccount(
  username: string,
  password: string
): Promise<AuthUser> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  }
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : 'Nome da conta ou senha incorretos.'
    );
  }
  if (typeof data.token === 'string') setStoredAuthToken(data.token);
  return data.user as AuthUser;
}

export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'include',
      headers: authHeaders(),
    });
    if (!res.ok) {
      if (res.status === 401) setStoredAuthToken(null);
      return null;
    }
    const data = await readJsonSafe(res);
    return (data.user as AuthUser) ?? null;
  } catch {
    return null;
  }
}

export async function logoutAccount(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(),
    });
  } catch {
    // ignore network failure on logout
  } finally {
    setStoredAuthToken(null);
  }
}

function notifyIfUnauthorized(res: Response) {
  if (res.status === 401) {
    setStoredAuthToken(null);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('retrohub-unauthorized'));
    }
  }
}

export async function fetchSavedLibrary(): Promise<LibraryGameItem[]> {
  const res = await fetch('/api/library', {
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  if (!res.ok) throw new Error('Falha ao carregar biblioteca salva.');
  const data = await readJsonSafe(res);
  return (data.games as LibraryGameItem[]) ?? [];
}

export async function saveGameToLibrary(params: {
  file: File;
  gameId: string;
  gameName: string;
  consoleId: string;
  consoleName: string;
}): Promise<LibraryGameItem> {
  const buf = await params.file.arrayBuffer();
  const res = await fetch('/api/library', {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders({
      'Content-Type': 'application/octet-stream',
      'x-game-id': params.gameId,
      'x-game-name': encodeURIComponent(params.gameName),
      'x-file-name': encodeURIComponent(params.file.name),
      'x-console-id': params.consoleId,
      'x-console-name': encodeURIComponent(params.consoleName),
    }),
    body: buf,
  });
  notifyIfUnauthorized(res);
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : 'Erro ao salvar jogo na biblioteca.'
    );
  }
  return data.game as LibraryGameItem;
}

export async function downloadSavedLibraryRom(item: LibraryGameItem): Promise<File> {
  const res = await fetch(`/api/library/${encodeURIComponent(item.gameId)}/rom`, {
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  if (!res.ok) {
    throw new Error('Não foi possível abrir o arquivo salvo.');
  }
  const blob = await res.blob();
  return new File([blob], item.fileName, { type: 'application/octet-stream' });
}

export async function removeGameFromLibrary(gameId: string): Promise<void> {
  const res = await fetch(`/api/library/${encodeURIComponent(gameId)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  if (!res.ok) throw new Error('Erro ao remover jogo da biblioteca.');
}

export async function fetchTeraBoxStatus(): Promise<TeraBoxStatus> {
  const res = await fetch('/api/terabox/status', {
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  if (!res.ok) {
    return { configured: false, connected: false, clientId: null };
  }
  return (await readJsonSafe(res)) as unknown as TeraBoxStatus;
}

export async function exchangeTeraBoxCode(
  code: string
): Promise<{ connected: boolean; uname: string }> {
  const res = await fetch('/api/terabox/exchange-code', {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ code }),
  });
  notifyIfUnauthorized(res);
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : 'Erro ao conectar conta TeraBox.'
    );
  }
  return data as { connected: boolean; uname: string };
}

export async function startTeraBoxDeviceCode(): Promise<TeraBoxDeviceCodeInfo> {
  const res = await fetch('/api/terabox/device-code', {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string' ? data.error : 'Erro ao gerar QR Code TeraBox.'
    );
  }
  return data as unknown as TeraBoxDeviceCodeInfo;
}

export async function pollTeraBoxDeviceCode(
  deviceCode: string
): Promise<{ status: 'pending' | 'connected' | 'error'; uname?: string; error?: string }> {
  const res = await fetch('/api/terabox/device-poll', {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ deviceCode }),
  });
  notifyIfUnauthorized(res);
  const data = await readJsonSafe(res);
  return data as { status: 'pending' | 'connected' | 'error'; uname?: string; error?: string };
}

export async function disconnectTeraBox(): Promise<void> {
  const res = await fetch('/api/terabox/disconnect', {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  if (!res.ok) throw new Error('Erro ao desconectar TeraBox.');
}

export async function migrateLocalGamesToTeraBox(): Promise<{ migratedCount: number }> {
  const res = await fetch('/api/terabox/migrate-local', {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : 'Erro ao sincronizar jogos locais com o TeraBox.'
    );
  }
  return { migratedCount: Number(data.migratedCount || 0) };
}


export interface StorageStatus {
  configured: boolean;
  database: string;
  files: string;
  bucket: string | null;
}

export async function fetchStorageStatus(): Promise<StorageStatus> {
  const res = await fetch('/api/storage/status', {
    credentials: 'include',
    headers: authHeaders(),
  });
  notifyIfUnauthorized(res);
  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Não foi possível verificar a nuvem.');
  }
  return data as unknown as StorageStatus;
}
