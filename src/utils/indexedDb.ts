import { ConsoleDefinition } from '../data/consoles';
import { ControlProfile, createDefaultProfile } from './controls';

const DB_NAME = 'RetroHubDB';
const DB_VERSION = 3;
const STORE_SAVES = 'saveStates';
const STORE_CONTROLS = 'controlProfiles';
const STORE_ROMS = 'gameRoms';
const LS_CONTROLS_PREFIX = 'retrohub_ctrl_';

let currentUserScope = 'guest';

export function setIndexedDbUserScope(userId: string | null) {
  currentUserScope = userId ? userId : 'guest';
}

function scopedGameKey(gameId: string): string {
  return `${currentUserScope}::${gameId}`;
}

function scopedProfileKey(rawProfileKey: string): string {
  return `${currentUserScope}::${rawProfileKey}`;
}

interface CachedGameRom {
  id: string;
  userId: string;
  gameId: string;
  fileName: string;
  fileSize: number;
  addedAt: number;
  blob: Blob;
  cachedAt: number;
}

export interface SaveStateRecord {
  id: string;
  userId?: string;
  gameId: string;
  gameName: string;
  consoleId: string;
  consoleName: string;
  slot: number; // 1..5
  data: ArrayBuffer;
  sizeBytes: number;
  updatedAt: number;
  screenshotDataUrl?: string;
}

export interface ExportedSaveBundle {
  format: 'retrohub-save-v1';
  gameId: string;
  gameName: string;
  consoleId: string;
  consoleName: string;
  slot: number;
  updatedAt: number;
  dataBase64: string;
  screenshotDataUrl?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB não suportado neste navegador.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SAVES)) {
        const saveStore = db.createObjectStore(STORE_SAVES, { keyPath: 'id' });
        saveStore.createIndex('byGameId', 'gameId', { unique: false });
        saveStore.createIndex('byConsoleId', 'consoleId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_CONTROLS)) {
        db.createObjectStore(STORE_CONTROLS, { keyPath: 'profileKey' });
      }
      if (!db.objectStoreNames.contains(STORE_ROMS)) {
        db.createObjectStore(STORE_ROMS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Erro ao abrir IndexedDB.'));
  });
}

const MAX_CACHED_ROM_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_ROM_CACHE_BYTES = 512 * 1024 * 1024;

/** Read a previously downloaded game ROM from this account's local cache. */
export async function getCachedGameRom(
  gameId: string,
  fileName: string,
  fileSize: number,
  addedAt: number
): Promise<Blob | null> {
  const db = await openDb();
  const id = scopedGameKey(gameId);
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_ROMS, 'readwrite');
      const store = tx.objectStore(STORE_ROMS);
      const request = store.get(id);
      let cached: Blob | null = null;

      request.onsuccess = () => {
        const record = request.result as CachedGameRom | undefined;
        if (
          record &&
          record.userId === currentUserScope &&
          record.gameId === gameId &&
          record.fileName === fileName &&
          record.fileSize === fileSize &&
          record.addedAt === addedAt &&
          record.blob instanceof Blob &&
          record.blob.size === fileSize
        ) {
          cached = record.blob;
          record.cachedAt = Date.now();
          store.put(record);
        } else if (record) {
          store.delete(id);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('Erro ao ler a ROM em cache.'));
      tx.oncomplete = () => resolve(cached);
      tx.onerror = () => reject(tx.error ?? new Error('Erro ao ler a ROM em cache.'));
      tx.onabort = () => reject(tx.error ?? new Error('Leitura da cache cancelada.'));
    });
  } finally {
    db.close();
  }
}

/** Persist a ROM locally so later launches do not have to download it again. */
export async function cacheGameRom(
  gameId: string,
  fileName: string,
  fileSize: number,
  addedAt: number,
  blob: Blob
): Promise<void> {
  if (!blob.size || blob.size > MAX_CACHED_ROM_BYTES || blob.size !== fileSize) return;

  const db = await openDb();
  const id = scopedGameKey(gameId);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ROMS, 'readwrite');
      const store = tx.objectStore(STORE_ROMS);
      const request = store.getAll();

      request.onsuccess = () => {
        const records = (request.result as CachedGameRom[]).filter((item) => item.id !== id);
        let totalBytes = blob.size + records.reduce((sum, item) => sum + (item.fileSize || 0), 0);

        // Keep the most recently used files and cap the cache to avoid filling phone storage.
        records.sort((a, b) => a.cachedAt - b.cachedAt);
        while (totalBytes > MAX_TOTAL_ROM_CACHE_BYTES && records.length > 0) {
          const oldest = records.shift()!;
          store.delete(oldest.id);
          totalBytes -= oldest.fileSize || 0;
        }

        const record: CachedGameRom = {
          id,
          userId: currentUserScope,
          gameId,
          fileName,
          fileSize,
          addedAt,
          blob,
          cachedAt: Date.now(),
        };
        store.put(record);
      };
      request.onerror = () => reject(request.error ?? new Error('Erro ao preparar a cache da ROM.'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Erro ao guardar a ROM em cache.'));
      tx.onabort = () => reject(tx.error ?? new Error('Cache da ROM cancelada.'));
    });
  } finally {
    db.close();
  }
}

export async function saveGameStateSlot(
  record: Omit<SaveStateRecord, 'id' | 'sizeBytes' | 'updatedAt'>
): Promise<SaveStateRecord> {
  const db = await openDb();
  const sGameId = scopedGameKey(record.gameId);
  const fullRecord: SaveStateRecord = {
    ...record,
    userId: currentUserScope,
    id: `${sGameId}::slot_${record.slot}`,
    sizeBytes: record.data.byteLength,
    updatedAt: Date.now(),
  };

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SAVES, 'readwrite');
    tx.objectStore(STORE_SAVES).put(fullRecord);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Erro ao gravar save state.'));
  });
  db.close();
  return fullRecord;
}

export async function getGameSaveSlots(gameId: string): Promise<(SaveStateRecord | null)[]> {
  const db = await openDb();
  const records = await new Promise<SaveStateRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_SAVES, 'readonly');
    const idx = tx.objectStore(STORE_SAVES).index('byGameId');
    const req = idx.getAll(gameId);
    req.onsuccess = () => resolve((req.result as SaveStateRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error('Erro ao ler save states.'));
  });
  db.close();

  const slots: (SaveStateRecord | null)[] = [null, null, null, null, null];
  for (const rec of records) {
    const recUser = rec.userId ?? 'guest';
    if (recUser !== currentUserScope) continue;
    if (rec.slot >= 1 && rec.slot <= 5) {
      slots[rec.slot - 1] = rec;
    }
  }
  return slots;
}

export async function getLatestGameSaveSlot(gameId: string): Promise<SaveStateRecord | null> {
  const slots = await getGameSaveSlots(gameId);
  const filled = slots.filter((s): s is SaveStateRecord => Boolean(s));
  if (filled.length === 0) return null;
  return filled.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export async function getAllSaveStates(): Promise<SaveStateRecord[]> {
  const db = await openDb();
  const records = await new Promise<SaveStateRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_SAVES, 'readonly');
    const req = tx.objectStore(STORE_SAVES).getAll();
    req.onsuccess = () => resolve((req.result as SaveStateRecord[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error('Erro ao listar saves.'));
  });
  db.close();
  return records
    .filter((rec) => (rec.userId ?? 'guest') === currentUserScope)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteSaveStateSlot(gameId: string, slot: number): Promise<void> {
  const db = await openDb();
  const key = `${scopedGameKey(gameId)}::slot_${slot}`;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_SAVES, 'readwrite');
    tx.objectStore(STORE_SAVES).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Erro ao remover save state.'));
  });
  db.close();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function exportSaveStateFile(record: SaveStateRecord): void {
  const bundle: ExportedSaveBundle = {
    format: 'retrohub-save-v1',
    gameId: record.gameId,
    gameName: record.gameName,
    consoleId: record.consoleId,
    consoleName: record.consoleName,
    slot: record.slot,
    updatedAt: record.updatedAt,
    dataBase64: arrayBufferToBase64(record.data),
    screenshotDataUrl: record.screenshotDataUrl,
  };
  const json = JSON.stringify(bundle);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const safeName =
    record.gameName
      .replace(/[^a-z0-9._-]+/gi, '_')
      .replace(/^_+|_+$/g, '') || 'save';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}_slot${record.slot}.rhsave`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function parseImportedSaveFile(
  file: File,
  fallbackMeta: { gameId: string; gameName: string; consoleId: string; consoleName: string; slot: number }
): Promise<Omit<SaveStateRecord, 'id' | 'sizeBytes' | 'updatedAt'>> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.rhsave') || lower.endsWith('.json')) {
    const text = await file.text();
    const parsed = JSON.parse(text) as Partial<ExportedSaveBundle>;
    if (
      parsed.format === 'retrohub-save-v1' &&
      typeof parsed.dataBase64 === 'string' &&
      parsed.dataBase64.length > 0
    ) {
      const screenshot =
        typeof parsed.screenshotDataUrl === 'string' &&
        parsed.screenshotDataUrl.startsWith('data:image/')
          ? parsed.screenshotDataUrl
          : undefined;
      let decodedData: ArrayBuffer;
      try {
        decodedData = base64ToArrayBuffer(parsed.dataBase64);
      } catch {
        throw new Error('Arquivo .rhsave inválido ou corrompido.');
      }
      const validParsedSlot =
        typeof parsed.slot === 'number' && parsed.slot >= 1 && parsed.slot <= 5
          ? parsed.slot
          : 1;
      const targetSlot =
        fallbackMeta.slot >= 1 && fallbackMeta.slot <= 5
          ? fallbackMeta.slot
          : validParsedSlot;
      return {
        gameId: fallbackMeta.gameId || String(parsed.gameId || 'imported').slice(0, 64),
        gameName: fallbackMeta.gameName || String(parsed.gameName || file.name).slice(0, 140),
        consoleId: fallbackMeta.consoleId || String(parsed.consoleId || 'nes').slice(0, 32),
        consoleName: fallbackMeta.consoleName || String(parsed.consoleName || 'Retro').slice(0, 64),
        slot: targetSlot,
        data: decodedData,
        screenshotDataUrl: screenshot,
      };
    }
    throw new Error('Arquivo .rhsave inválido ou corrompido.');
  }

  const data = await file.arrayBuffer();
  if (data.byteLength === 0) {
    throw new Error('Arquivo de save state está vazio.');
  }
  const validSlot =
    fallbackMeta.slot >= 1 && fallbackMeta.slot <= 5 ? fallbackMeta.slot : 1;
  return {
    gameId: fallbackMeta.gameId || 'imported',
    gameName: fallbackMeta.gameName || file.name,
    consoleId: fallbackMeta.consoleId || 'nes',
    consoleName: fallbackMeta.consoleName || 'Retro',
    slot: validSlot,
    data,
  };
}

function mergeControlProfileDefaults(
  parsed: Partial<ControlProfile>,
  consoleDef: ConsoleDefinition,
  gameId?: string,
  gameName?: string
): ControlProfile {
  const def = createDefaultProfile(consoleDef, gameId, gameName);
  return {
    ...def,
    ...parsed,
    keyboard: { ...def.keyboard, ...(parsed.keyboard ?? {}) },
    gamepad: { ...def.gamepad, ...(parsed.gamepad ?? {}) },
    touch: Array.isArray(parsed.touch) && parsed.touch.length > 0 ? parsed.touch : def.touch,
    touchOpacity:
      typeof parsed.touchOpacity === 'number' &&
      parsed.touchOpacity >= 0.2 &&
      parsed.touchOpacity <= 1
        ? parsed.touchOpacity
        : def.touchOpacity,
  };
}

export function loadControlProfileSync(
  consoleDef: ConsoleDefinition,
  gameId?: string,
  gameName?: string
): ControlProfile {
  if (gameId) {
    try {
      const rawGame = localStorage.getItem(
        `${LS_CONTROLS_PREFIX}${scopedProfileKey(`game:${gameId}`)}`
      );
      if (rawGame) {
        return mergeControlProfileDefaults(
          JSON.parse(rawGame) as Partial<ControlProfile>,
          consoleDef,
          gameId,
          gameName
        );
      }
    } catch {
      // ignore
    }
  }
  try {
    const rawConsole = localStorage.getItem(
      `${LS_CONTROLS_PREFIX}${scopedProfileKey(`console:${consoleDef.id}`)}`
    );
    if (rawConsole) {
      return mergeControlProfileDefaults(
        JSON.parse(rawConsole) as Partial<ControlProfile>,
        consoleDef,
        gameId,
        gameName
      );
    }
  } catch {
    // ignore
  }
  return createDefaultProfile(consoleDef, gameId, gameName);
}

export async function saveControlProfile(profile: ControlProfile): Promise<void> {
  const updated: ControlProfile = { ...profile, updatedAt: Date.now() };
  const sKey = scopedProfileKey(updated.profileKey);
  try {
    localStorage.setItem(`${LS_CONTROLS_PREFIX}${sKey}`, JSON.stringify(updated));
  } catch {
    // ignore
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CONTROLS, 'readwrite');
      tx.objectStore(STORE_CONTROLS).put({ ...updated, profileKey: sKey });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}

export async function deleteGameControlProfile(gameId: string): Promise<void> {
  const sKey = scopedProfileKey(`game:${gameId}`);
  try {
    localStorage.removeItem(`${LS_CONTROLS_PREFIX}${sKey}`);
  } catch {
    // ignore
  }
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_CONTROLS, 'readwrite');
      tx.objectStore(STORE_CONTROLS).delete(sKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // ignore
  }
}
