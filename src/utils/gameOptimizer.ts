export interface GameDeviceInfo {
  deviceName: string;
  platform: string;
  browser: string;
  cpuCores: number | null;
  memoryGB: number | null;
  gpu: string;
  graphicsApi: string;
  webgl2: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  screen: string;
  pixelRatio: number;
  tier: 'low' | 'medium' | 'high' | 'unknown';
}

export interface GameOptimizationProfile {
  threads: boolean;
  forceLegacyCores: boolean;
  updatedAt: number;
  reason: string;
}

type ExtendedNavigator = Navigator & {
  deviceMemory?: number;
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
    brands?: Array<{ brand: string; version: string }>;
    getHighEntropyValues?: (hints: string[]) => Promise<{
      model?: string;
      platform?: string;
      fullVersionList?: Array<{ brand: string; version: string }>;
    }>;
  };
};

function browserName(userAgent: string, brands?: Array<{ brand: string; version: string }>): string {
  if (brands?.length) {
    const preferred = brands.find((item) => !/Not.A.Brand/i.test(item.brand)) ?? brands[0];
    return preferred.brand + (preferred.version ? ' ' + preferred.version : '');
  }
  if (/Edg\//.test(userAgent)) return 'Microsoft Edge';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/CriOS|Chrome\//.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Navegador não identificado';
}

function guessDeviceName(userAgent: string): string {
  const android = userAgent.match(/Android[^;)]*;\s*([^;)]+)(?:\s+Build\/[^;)]+)?/i);
  if (android?.[1]) {
    const model = android[1].replace(/\s*Build\/.*$/i, '').trim();
    if (model && !/^wv$/i.test(model)) return model;
  }
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/Windows/i.test(userAgent)) return 'PC Windows';
  if (/Mac OS/i.test(userAgent)) return 'Mac';
  if (/Linux/i.test(userAgent)) return 'Dispositivo Linux';
  return 'Dispositivo não identificado';
}

export async function inspectGameDevice(): Promise<GameDeviceInfo> {
  const nav = navigator as ExtendedNavigator;
  const userAgent = nav.userAgent || '';
  const uaData = nav.userAgentData;
  let highEntropy: { model?: string; platform?: string; fullVersionList?: Array<{ brand: string; version: string }> } = {};

  try {
    highEntropy = (await uaData?.getHighEntropyValues?.(['model', 'platform', 'fullVersionList'])) ?? {};
  } catch {
    // User-Agent Client Hints may be unavailable or restricted.
  }

  let gpu = 'GPU não exposta pelo navegador';
  let graphicsApi = 'WebGL não disponível';
  let webgl2 = false;
  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;

  try {
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    webgl2 = Boolean(gl);
    if (gl) {
      graphicsApi = 'WebGL 2';
    } else {
      gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
      if (gl) graphicsApi = 'WebGL 1';
    }

    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info') as
        | { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number }
        | null;
      if (debugInfo) {
        const vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        gpu = [vendor, renderer].filter(Boolean).join(' · ') || gpu;
      } else {
        gpu = String(gl.getParameter(gl.RENDERER) || gpu);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // Graphics details may be hidden by browser privacy settings.
  }

  const cpuCores = Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null;
  const memoryGB = Number.isFinite(nav.deviceMemory) ? nav.deviceMemory ?? null : null;
  const platform = highEntropy.platform || uaData?.platform || nav.platform || 'Plataforma não identificada';
  const deviceName = highEntropy.model || guessDeviceName(userAgent);
  const lowResource = (cpuCores !== null && cpuCores <= 4) || (memoryGB !== null && memoryGB <= 4);
  const highResource = cpuCores !== null && cpuCores >= 8 && memoryGB !== null && memoryGB >= 6 && webgl2;
  const tier: GameDeviceInfo['tier'] =
    lowResource ? 'low' : highResource ? 'high' : cpuCores !== null || memoryGB !== null ? 'medium' : 'unknown';

  return {
    deviceName,
    platform,
    browser: browserName(userAgent, highEntropy.fullVersionList || uaData?.brands),
    cpuCores,
    memoryGB,
    gpu,
    graphicsApi,
    webgl2,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: window.crossOriginIsolated === true,
    screen: `${window.screen.width} × ${window.screen.height}`,
    pixelRatio: window.devicePixelRatio || 1,
    tier,
  };
}

const PROFILE_PREFIX = 'retrohub:game-optimizer:';

function profileKey(consoleId: string, gameId: string): string {
  return PROFILE_PREFIX + encodeURIComponent(consoleId) + ':' + encodeURIComponent(gameId);
}

export function saveGameOptimizationProfile(
  consoleId: string,
  gameId: string,
  profile: GameOptimizationProfile
): void {
  try {
    localStorage.setItem(profileKey(consoleId, gameId), JSON.stringify(profile));
  } catch {
    // Private browsing or storage restrictions should not break the emulator.
  }
}

export function loadGameOptimizationProfile(
  consoleId: string,
  gameId: string
): GameOptimizationProfile | null {
  try {
    const raw = localStorage.getItem(profileKey(consoleId, gameId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GameOptimizationProfile>;
    if (typeof parsed.threads !== 'boolean' || typeof parsed.forceLegacyCores !== 'boolean') return null;
    return {
      threads: parsed.threads,
      forceLegacyCores: parsed.forceLegacyCores,
      updatedAt: Number(parsed.updatedAt) || 0,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return null;
  }
}

export function removeGameOptimizationProfile(consoleId: string, gameId: string): void {
  try {
    localStorage.removeItem(profileKey(consoleId, gameId));
  } catch {
    // Ignore unavailable storage.
  }
}

export function canUseEmulatorThreads(device: GameDeviceInfo): boolean {
  return device.sharedArrayBuffer && device.crossOriginIsolated && (device.cpuCores ?? 0) >= 6;
}
