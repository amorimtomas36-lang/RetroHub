import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Gamepad2,
  HardDrive,
  LogOut,
  Maximize2,
  Minimize2,
  MousePointer2,
  Move,
  RotateCcw,
  Save,
  Settings,
  Smartphone,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { ActionId, ConsoleDefinition } from '../data/consoles';
import { useGamepad } from '../hooks/useGamepad';
import {
  ControlProfile,
  createDefaultTouchLayout,
} from '../utils/controls';
import {
  SaveStateRecord,
  deleteSaveStateSlot,
  exportSaveStateFile,
  getGameSaveSlots,
  getLatestGameSaveSlot,
  loadControlProfileSync,
  parseImportedSaveFile,
  saveControlProfile,
  saveGameStateSlot,
} from '../utils/indexedDb';
import { formatBytes } from '../utils/romDetector';
import { ExitSaveModal } from './ExitSaveModal';
import { TouchControlsOverlay } from './TouchControlsOverlay';

export interface ActiveRomSession {
  file: File;
  gameId: string;
  gameName: string;
  consoleDef: ConsoleDefinition;
}

interface EmulatorPlayerProps {
  session: ActiveRomSession;
  onExit: () => void;
  onOpenControlsConfig: (consoleId: string, gameId: string, gameName: string) => void;
}

// RetroArch / EmulatorJS joypad button indices used by gameManager.simulateInput
const ACTION_TO_EJS_INDEX: Record<ActionId, number> = {
  b: 0,
  y: 1,
  select: 2,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
  a: 8,
  x: 9,
  l: 10,
  r: 11,
  l2: 12,
  r2: 13,
};

// Canonical keyCodes configured inside EmulatorJS iframe
const CANONICAL_ACTION_KEYCODES: Record<ActionId, number> = {
  b: 90, // Z
  y: 65, // A
  select: 16, // Shift
  start: 13, // Enter
  up: 38,
  down: 40,
  left: 37,
  right: 39,
  a: 88, // X
  x: 83, // S
  l: 81, // Q
  r: 87, // W
  l2: 49, // 1
  r2: 50, // 2
};

export const EmulatorPlayer: React.FC<EmulatorPlayerProps> = ({
  session,
  onExit,
  onOpenControlsConfig,
}) => {
  const { file, gameId, gameName, consoleDef } = session;
  const stageRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [romBlobUrl, setRomBlobUrl] = useState<string>('');
  const [autoRestoreDone, setAutoRestoreDone] = useState(false);
  const [emuStatus, setEmuStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [statusMessage, setStatusMessage] = useState<string>('Inicializando núcleo EmulatorJS...');
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Touch & Mouse controls state
  const [showTouchOverlay, setShowTouchOverlay] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 900;
  });
  const [editTouchLayout, setEditTouchLayout] = useState(false);
  const [touchCenterWarn, setTouchCenterWarn] = useState(false);
  const [mouseMode, setMouseMode] = useState<boolean>(consoleDef.supportsMouse);

  // Control profile (reloadable when returning from settings)
  const [profile, setProfile] = useState<ControlProfile>(() =>
    loadControlProfileSync(consoleDef, gameId, gameName)
  );

  // 5-slot Save states
  const [slots, setSlots] = useState<(SaveStateRecord | null)[]>([null, null, null, null, null]);
  const [activeSlot, setActiveSlot] = useState<number>(1);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const [exitModalOpen, setExitModalOpen] = useState(false);
  const [savingBeforeExit, setSavingBeforeExit] = useState(false);
  const [exitSaveError, setExitSaveError] = useState<string | null>(null);
  const [gamepadNotice, setGamepadNotice] = useState<string | null>(null);
  const gamepadTimerRef = useRef<number | null>(null);

  // Audio health & live controls (kept out of iframeSrcDoc deps so adjustments never reload the game)
  const [audioState, setAudioState] = useState<'unknown' | 'suspended' | 'running'>('unknown');
  const audioStateRef = useRef<'unknown' | 'suspended' | 'running'>('unknown');
  audioStateRef.current = audioState;
  const [audioVolume, setAudioVolume] = useState<number>(0.85);
  const audioVolumeRef = useRef<number>(0.85);
  audioVolumeRef.current = audioVolume;
  const [audioMuted, setAudioMuted] = useState<boolean>(false);
  const audioMutedRef = useRef<boolean>(false);
  audioMutedRef.current = audioMuted;
  const [vsyncEnabled, setVsyncEnabled] = useState<boolean>(true);

  const showFeedback = useCallback((msg: string, durationMs = 2800) => {
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    setSaveFeedback(msg);
    feedbackTimerRef.current = window.setTimeout(() => {
      setSaveFeedback(null);
      feedbackTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
      if (gamepadTimerRef.current !== null) clearTimeout(gamepadTimerRef.current);
    };
  }, []);

  // Create & revoke ROM Blob URL safely
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setRomBlobUrl(url);
    setAutoRestoreDone(false);
    setEmuStatus('loading');
    setStatusMessage(`Carregando núcleo ${consoleDef.name} (${consoleDef.ejsCore})...`);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file, consoleDef]);

  // Refresh profile and IndexedDB save slots on mount
  const refreshSlots = useCallback(async () => {
    try {
      const list = await getGameSaveSlots(gameId);
      setSlots(list);
    } catch {
      // ignore
    }
  }, [gameId]);

  useEffect(() => {
    setProfile(loadControlProfileSync(consoleDef, gameId, gameName));
    refreshSlots();
  }, [consoleDef, gameId, gameName, refreshSlots]);

  // Build srcdoc for isolated EmulatorJS iframe (same-origin access for state & input)
  const iframeSrcDoc = useMemo(() => {
    if (!romBlobUrl) return '';
    const controlsObj: Record<number, Record<number, { value: number; value2: string }>> = {
      0: {},
    };
    (Object.keys(ACTION_TO_EJS_INDEX) as ActionId[]).forEach((act) => {
      const idx = ACTION_TO_EJS_INDEX[act];
      controlsObj[0][idx] = {
        value: CANONICAL_ACTION_KEYCODES[act],
        value2: '',
      };
    });

    const safeName = gameName.replace(/[<>"'\\]/g, '') || 'Jogo';
    const numericGameId = Math.abs(
      Array.from(gameId).reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) | 0), 7)
    ) || 1;

    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      background: #0b0d12; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
    }
    #game { width: 100%; height: 100%; }
    /* Hide EmulatorJS built-in virtual gamepad when custom touch overlay is used */
    .ejs_virtualGamepad_parent { display: none !important; }
  </style>
  <script>
    (function() {
      var trackedContexts = [];
      window.__retrohubAudioContexts = trackedContexts;

      function notifyAudioState() {
        var state = 'unknown';
        var sampleRate = 0;
        for (var i = 0; i < trackedContexts.length; i++) {
          var c = trackedContexts[i];
          if (!c || c.state === 'closed') continue;
          sampleRate = c.sampleRate || sampleRate;
          if (c.state === 'running') {
            state = 'running';
            break;
          }
          if (c.state === 'suspended') {
            state = 'suspended';
          }
        }
        try {
          if (state === 'unknown' && window.EJS_emulator && window.EJS_emulator.Module && window.EJS_emulator.Module.AL && window.EJS_emulator.Module.AL.currentCtx && window.EJS_emulator.Module.AL.currentCtx.audioCtx) {
            var alCtx = window.EJS_emulator.Module.AL.currentCtx.audioCtx;
            state = alCtx.state || 'unknown';
            sampleRate = alCtx.sampleRate || sampleRate;
          }
        } catch (e) {}
        try {
          window.parent.postMessage({
            type: 'retrohub-audio-state',
            state: state,
            sampleRate: sampleRate
          }, '*');
        } catch (e) {}
      }

      function trackContext(ctx) {
        if (!ctx || trackedContexts.indexOf(ctx) !== -1) return ctx;
        trackedContexts.push(ctx);
        try {
          ctx.addEventListener('statechange', notifyAudioState);
        } catch (e) {}
        notifyAudioState();
        return ctx;
      }

      var NativeAudioCtx = window.AudioContext || window.webkitAudioContext;
      if (NativeAudioCtx) {
        var PatchedAudioContext = function(options) {
          var opts = options && typeof options === 'object' ? Object.assign({}, options) : {};
          // Use 'playback' buffer sizing instead of tight 'interactive' buffer to prevent mobile/browser audio crackling
          if (!opts.latencyHint || opts.latencyHint === 'interactive') {
            opts.latencyHint = 'playback';
          }
          var instance;
          try {
            instance = new NativeAudioCtx(opts);
          } catch (err) {
            instance = new NativeAudioCtx();
          }
          return trackContext(instance);
        };
        PatchedAudioContext.prototype = NativeAudioCtx.prototype;
        window.AudioContext = PatchedAudioContext;
        if (window.webkitAudioContext) {
          window.webkitAudioContext = PatchedAudioContext;
        }
      }

      window.__retrohubResumeAudio = function() {
        var resumedAny = false;
        try {
          if (window.EJS_emulator && window.EJS_emulator.Module && window.EJS_emulator.Module.AL && window.EJS_emulator.Module.AL.currentCtx && window.EJS_emulator.Module.AL.currentCtx.audioCtx) {
            trackContext(window.EJS_emulator.Module.AL.currentCtx.audioCtx);
          }
        } catch (e) {}
        for (var i = 0; i < trackedContexts.length; i++) {
          var c = trackedContexts[i];
          if (c && c.state === 'suspended' && typeof c.resume === 'function') {
            resumedAny = true;
            c.resume().then(notifyAudioState).catch(function() {});
          }
        }
        if (!resumedAny) notifyAudioState();
      };

      window.__retrohubResetAudio = function() {
        try {
          if (window.EJS_emulator && window.EJS_emulator.Module && window.EJS_emulator.Module.AL && window.EJS_emulator.Module.AL.currentCtx && window.EJS_emulator.Module.AL.currentCtx.audioCtx) {
            trackContext(window.EJS_emulator.Module.AL.currentCtx.audioCtx);
          }
        } catch (e) {}
        for (var i = 0; i < trackedContexts.length; i++) {
          (function(c) {
            if (!c || c.state === 'closed') return;
            if (typeof c.suspend === 'function' && typeof c.resume === 'function') {
              c.suspend().catch(function() {}).finally(function() {
                setTimeout(function() {
                  c.resume().then(notifyAudioState).catch(function() {});
                }, 40);
              });
            }
          })(trackedContexts[i]);
        }
      };

      window.__retrohubApplyVolume = function(vol, muted) {
        var target = muted ? 0 : Math.max(0, Math.min(1, Number(vol) || 0));
        try {
          if (window.EJS_emulator) {
            window.EJS_emulator.volume = muted ? (vol || 0.85) : target;
            window.EJS_emulator.muted = Boolean(muted || target === 0);
            if (typeof window.EJS_emulator.setVolume === 'function') {
              window.EJS_emulator.setVolume(target);
            }
            if (window.EJS_emulator.Module && window.EJS_emulator.Module.AL && window.EJS_emulator.Module.AL.currentCtx && window.EJS_emulator.Module.AL.currentCtx.sources) {
              window.EJS_emulator.Module.AL.currentCtx.sources.forEach(function(src) {
                if (src && src.gain && src.gain.gain) {
                  src.gain.gain.value = target;
                }
              });
            }
          }
        } catch (e) {}
      };

      window.__retrohubCloseAudio = function() {
        for (var i = 0; i < trackedContexts.length; i++) {
          var c = trackedContexts[i];
          if (c && c.state !== 'closed' && typeof c.close === 'function') {
            try { c.close(); } catch (e) {}
          }
        }
      };

      ['pointerdown', 'touchstart', 'mousedown', 'keydown'].forEach(function(evt) {
        window.addEventListener(evt, function() {
          window.__retrohubResumeAudio();
        }, true);
      });
      window.addEventListener('pagehide', function() {
        window.__retrohubCloseAudio();
      });
    })();

    window.EJS_player = '#game';
    window.EJS_core = ${JSON.stringify(consoleDef.ejsCore)};
    window.EJS_gameID = ${numericGameId};
    window.EJS_gameName = ${JSON.stringify(safeName)};
    window.EJS_gameUrl = ${JSON.stringify(romBlobUrl)};
    window.EJS_biosUrl = '';
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
    window.EJS_threads = false;
    window.EJS_volume = 0.85;
    window.EJS_color = '#f97316';
    window.EJS_backgroundColor = '#0b0d12';
    window.EJS_startOnLoaded = true;
    window.EJS_defaultControls = ${JSON.stringify(controlsObj)};
    window.EJS_Buttons = {
      playPause: true,
      restart: true,
      mute: true,
      settings: false,
      fullscreen: false,
      saveState: false,
      loadState: false,
      screenRecord: false,
      gamepad: false,
      cheat: false,
      volume: true,
      saveSavFiles: false,
      loadSavFiles: false,
      quickSave: false,
      quickLoad: false,
      screenshot: true,
      cacheManager: false
    };
    window.EJS_onGameStart = function() {
      setTimeout(function() {
        window.__retrohubResumeAudio();
      }, 100);
      window.parent.postMessage({ type: 'retrohub-ejs-ready' }, '*');
    };
  </script>
  <script
    src="https://cdn.emulatorjs.org/stable/data/loader.js"
    onerror="window.parent.postMessage({ type: 'retrohub-ejs-error', message: 'Não foi possível carregar o motor EmulatorJS (verifique a conexão com a internet).' }, '*')"
  ></script>
</body>
</html>`;
  }, [romBlobUrl, consoleDef.ejsCore, gameId, gameName]);

  // Helper to unlock AudioContext inside the emulator iframe from parent interactions
  const resumeIframeAudio = useCallback(() => {
    try {
      const win = iframeRef.current?.contentWindow as
        | (Window & { __retrohubResumeAudio?: () => void })
        | null;
      win?.__retrohubResumeAudio?.();
    } catch {
      // ignore
    }
  }, []);

  const applyIframeVolume = useCallback((vol: number, muted: boolean) => {
    try {
      const win = iframeRef.current?.contentWindow as
        | (Window & { __retrohubApplyVolume?: (v: number, m: boolean) => void })
        | null;
      win?.__retrohubApplyVolume?.(vol, muted);
    } catch {
      // ignore
    }
  }, []);

  // Close AudioContext cleanly if EmulatorPlayer unmounts
  useEffect(() => {
    const iframeEl = iframeRef.current;
    return () => {
      try {
        const win = iframeEl?.contentWindow as
          | (Window & { __retrohubCloseAudio?: () => void })
          | null;
        win?.__retrohubCloseAudio?.();
      } catch {
        // ignore
      }
    };
  }, [iframeSrcDoc]);

  // Listen for iframe readiness / errors / audio state & auto-restore latest save state if present
  useEffect(() => {
    let active = true;
    let restoreTimer: number | null = null;

    const onMessage = (e: MessageEvent) => {
      if (!active || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'retrohub-audio-state') {
        const st = e.data.state;
        if (st === 'running' || st === 'suspended' || st === 'unknown') {
          setAudioState(st);
        }
        return;
      }
      if (e.data.type === 'retrohub-ejs-ready') {
        setEmuStatus('ready');
        setStatusMessage('Emulação ativa');
        resumeIframeAudio();
        applyIframeVolume(audioVolumeRef.current, audioMutedRef.current);
        if (!autoRestoreDone) {
          setAutoRestoreDone(true);
          restoreTimer = window.setTimeout(async () => {
            if (!active) return;
            try {
              const latest = await getLatestGameSaveSlot(gameId);
              if (!active || !latest) return;
              const win = iframeRef.current?.contentWindow as
                | (Window & {
                    EJS_emulator?: {
                      gameManager?: { loadState?: (state: Uint8Array) => void };
                    };
                  })
                | null;
              const gm = win?.EJS_emulator?.gameManager;
              if (gm && typeof gm.loadState === 'function') {
                gm.loadState(new Uint8Array(latest.data));
                setActiveSlot(latest.slot);
                showFeedback(`Progresso restaurado automaticamente do Slot ${latest.slot}!`, 3200);
              }
            } catch {
              // ignore auto-restore failure
            }
          }, 700);
        }
      } else if (e.data.type === 'retrohub-ejs-error') {
        setEmuStatus('error');
        setStatusMessage(e.data.message || 'Erro ao inicializar EmulatorJS.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      active = false;
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      window.removeEventListener('message', onMessage);
    };
  }, [autoRestoreDone, gameId, applyIframeVolume, resumeIframeAudio, showFeedback]);

  // Automatically unlock iframe AudioContext when user interacts anywhere on parent (Touch overlay, clicks, keys)
  useEffect(() => {
    const unlock = () => {
      if (audioStateRef.current !== 'running') {
        resumeIframeAudio();
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, [resumeIframeAudio]);

  // Dispatch an action state (Keyboard / Gamepad / Touch) straight into EmulatorJS
  const sendActionToEmulator = useCallback((action: ActionId, pressed: boolean) => {
    if (pressed && audioStateRef.current !== 'running') {
      resumeIframeAudio();
    }
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    const win = iframe.contentWindow as Window & {
      EJS_emulator?: {
        gameManager?: {
          simulateInput?: (player: number, index: number, value: number) => void;
        };
      };
    };

    const btnIndex = ACTION_TO_EJS_INDEX[action];
    const gm = win.EJS_emulator?.gameManager;
    if (gm && typeof gm.simulateInput === 'function') {
      gm.simulateInput(0, btnIndex, pressed ? 1 : 0);
      return;
    }

    // Fallback synthetic KeyboardEvent to EmulatorJS document
    const keyCode = CANONICAL_ACTION_KEYCODES[action];
    try {
      const target = win.document.querySelector('canvas') || win.document;
      const ev = new KeyboardEvent(pressed ? 'keydown' : 'keyup', {
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(ev);
    } catch {
      // ignore cross-context errors
    }
  }, [resumeIframeAudio]);

  // Build reverse lookup: KeyboardEvent.code -> ActionId
  const codeToAction = useMemo(() => {
    const map = new Map<string, ActionId>();
    for (const act of consoleDef.actions) {
      const code = profile.keyboard[act];
      if (code) map.set(code, act);
    }
    return map;
  }, [consoleDef.actions, profile.keyboard]);

  // Attach unified keyboard translation on both parent window AND inside iframe
  useEffect(() => {
    const activeKeys = new Set<ActionId>();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (exitModalOpen) return;
      const mapped = codeToAction.get(e.code);
      if (mapped) {
        e.preventDefault();
        e.stopPropagation();
        if (!activeKeys.has(mapped)) {
          activeKeys.add(mapped);
          sendActionToEmulator(mapped, true);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const mapped = codeToAction.get(e.code);
      if (mapped) {
        e.preventDefault();
        e.stopPropagation();
        activeKeys.delete(mapped);
        sendActionToEmulator(mapped, false);
      }
    };

    const releaseAll = () => {
      activeKeys.forEach((act) => sendActionToEmulator(act, false));
      activeKeys.clear();
    };

    const handleVis = () => {
      if (document.hidden) releaseAll();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', handleVis);

    const attachIframeKeys = () => {
      try {
        const iWin = iframeRef.current?.contentWindow;
        if (!iWin) return;
        iWin.addEventListener('keydown', handleKeyDown, true);
        iWin.addEventListener('keyup', handleKeyUp, true);
        iWin.addEventListener('blur', releaseAll);
      } catch {
        // ignore
      }
    };

    const iframeEl = iframeRef.current;
    iframeEl?.addEventListener('load', attachIframeKeys);
    attachIframeKeys();

    return () => {
      releaseAll();
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', handleVis);
      iframeEl?.removeEventListener('load', attachIframeKeys);
      try {
        const iWin = iframeEl?.contentWindow;
        iWin?.removeEventListener('keydown', handleKeyDown, true);
        iWin?.removeEventListener('keyup', handleKeyUp, true);
        iWin?.removeEventListener('blur', releaseAll);
      } catch {
        // ignore
      }
    };
  }, [codeToAction, exitModalOpen, sendActionToEmulator]);

  // Gamepad API live binding + disconnect handling
  const { gamepads } = useGamepad({
    enabled: !exitModalOpen,
    bindings: profile.gamepad,
    allowedActions: consoleDef.actions,
    onActionStateChange: sendActionToEmulator,
    onDisconnectNotice: (id) => {
      if (gamepadTimerRef.current !== null) clearTimeout(gamepadTimerRef.current);
      setGamepadNotice(`Controle desconectado: ${id.slice(0, 32)}. Controles de teclado e touch continuam ativos.`);
      gamepadTimerRef.current = window.setTimeout(() => setGamepadNotice(null), 5000);
    },
  });

  // Extract state bytes & optional screenshot from EmulatorJS
  const captureEmuState = useCallback(async (): Promise<{
    data: ArrayBuffer;
    screenshotDataUrl?: string;
  }> => {
    const win = iframeRef.current?.contentWindow as
      | (Window & {
          EJS_emulator?: {
            gameManager?: {
              getState?: () => Uint8Array;
              screenshot?: () => Uint8Array | string;
            };
          };
        })
      | null;

    const gm = win?.EJS_emulator?.gameManager;
    if (!gm || typeof gm.getState !== 'function') {
      throw new Error('O núcleo ainda está inicializando. Aguarde o jogo iniciar para salvar.');
    }
    const rawState = gm.getState();
    const copy = new Uint8Array(rawState.byteLength);
    copy.set(rawState);

    let screenshotDataUrl: string | undefined;
    try {
      const canvas = win?.document.querySelector('canvas');
      if (canvas) {
        screenshotDataUrl = canvas.toDataURL('image/jpeg', 0.6);
      }
    } catch {
      // ignore tainted canvas
    }

    return { data: copy.buffer, screenshotDataUrl };
  }, []);

  const handleSaveSlot = async (slot: number) => {
    try {
      setSaveFeedback(`Salvando Slot ${slot}...`);
      const { data, screenshotDataUrl } = await captureEmuState();
      await saveGameStateSlot({
        gameId,
        gameName,
        consoleId: consoleDef.id,
        consoleName: consoleDef.name,
        slot,
        data,
        screenshotDataUrl,
      });
      await refreshSlots();
      setActiveSlot(slot);
      showFeedback(`Progresso salvo no Slot ${slot}!`, 2800);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : 'Falha ao salvar estado.', 4000);
    }
  };

  const handleLoadSlot = async (slot: number) => {
    const record = slots[slot - 1];
    if (!record) {
      showFeedback(`Slot ${slot} está vazio.`, 2200);
      return;
    }
    const win = iframeRef.current?.contentWindow as
      | (Window & {
          EJS_emulator?: {
            gameManager?: {
              loadState?: (state: Uint8Array) => void;
            };
          };
        })
      | null;

    const gm = win?.EJS_emulator?.gameManager;
    if (!gm || typeof gm.loadState !== 'function') {
      showFeedback('Aguarde o jogo iniciar para carregar um save state.', 3000);
      return;
    }
    try {
      gm.loadState(new Uint8Array(record.data));
      setActiveSlot(slot);
      showFeedback(`Slot ${slot} carregado!`, 2400);
    } catch {
      showFeedback(`Não foi possível carregar o Slot ${slot}.`, 3200);
    }
  };

  const handleImportSave = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const parsed = await parseImportedSaveFile(f, {
        gameId,
        gameName,
        consoleId: consoleDef.id,
        consoleName: consoleDef.name,
        slot: activeSlot,
      });
      await saveGameStateSlot(parsed);
      await refreshSlots();
      showFeedback(`Save importado para o Slot ${activeSlot}! Clique em Carregar para aplicar.`, 3500);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : 'Erro ao importar save.', 3500);
    }
  };

  const handleDeleteSlot = async (slot: number) => {
    await deleteSaveStateSlot(gameId, slot);
    await refreshSlots();
    showFeedback(`Slot ${slot} apagado.`, 2200);
  };

  const handleToggleFullscreen = async () => {
    if (!stageRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await stageRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // ignore fullscreen errors inside restricted iframes
    }
  };

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const handleSaveAndExit = async (slot: number) => {
    setSavingBeforeExit(true);
    setExitSaveError(null);
    try {
      const { data, screenshotDataUrl } = await captureEmuState();
      await saveGameStateSlot({
        gameId,
        gameName,
        consoleId: consoleDef.id,
        consoleName: consoleDef.name,
        slot,
        data,
        screenshotDataUrl,
      });
      setExitModalOpen(false);
      onExit();
    } catch (err) {
      setExitSaveError(
        err instanceof Error
          ? err.message
          : 'Não foi possível salvar no momento. Tente novamente ou saia sem salvar.'
      );
    } finally {
      setSavingBeforeExit(false);
    }
  };

  const handleTouchLayoutChange = (nextTouch: ControlProfile['touch']) => {
    const updated: ControlProfile = { ...profile, touch: nextTouch };
    setProfile(updated);
    saveControlProfile(updated);
  };

  const handleResetTouchLayout = () => {
    const updated: ControlProfile = {
      ...profile,
      touch: createDefaultTouchLayout(consoleDef),
    };
    setProfile(updated);
    saveControlProfile(updated);
    showFeedback('Layout touch restaurado para o padrão.', 2500);
  };

  return (
    <div className="space-y-4">
      {/* Top Control & Session Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-xl border border-white/10 bg-[#141821]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>{consoleDef.name}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-tabular">{consoleDef.ejsCore}</span>
            {gamepads.length > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-emerald-400 flex items-center gap-1">
                  <Gamepad2 className="w-3.5 h-3.5" />
                  Controle conectado
                </span>
              </>
            )}
          </div>
          <h1 className="text-base sm:text-lg font-semibold text-white truncate max-w-xl">
            {gameName}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {audioState === 'suspended' && (
            <button
              type="button"
              onClick={() => {
                resumeIframeAudio();
                applyIframeVolume(audioVolume, false);
                setAudioMuted(false);
                showFeedback('Áudio desbloqueado no navegador!', 2400);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-slate-950 transition-colors whitespace-nowrap"
            >
              <Volume2 className="w-3.5 h-3.5" />
              Ativar Áudio
            </button>
          )}

          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-[#0B0D12]">
            <button
              type="button"
              onClick={() => {
                resumeIframeAudio();
                const nextMuted = !audioMuted;
                setAudioMuted(nextMuted);
                applyIframeVolume(audioVolume, nextMuted);
              }}
              title={audioMuted ? 'Ativar som' : 'Silenciar som'}
              aria-label={audioMuted ? 'Ativar som' : 'Silenciar som'}
              className="text-slate-300 hover:text-white transition-colors"
            >
              {audioMuted || audioVolume === 0 ? (
                <VolumeX className="w-3.5 h-3.5 text-red-400" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={audioMuted ? 0 : audioVolume}
              onChange={(e) => {
                resumeIframeAudio();
                const val = Number(e.target.value);
                setAudioVolume(val);
                const nextMuted = val === 0;
                setAudioMuted(nextMuted);
                applyIframeVolume(val, nextMuted);
              }}
              aria-label="Volume do emulador"
              className="w-16 sm:w-20 accent-orange-500 cursor-pointer"
            />
            <button
              type="button"
              onClick={() => {
                try {
                  const win = iframeRef.current?.contentWindow as
                    | (Window & { __retrohubResetAudio?: () => void })
                    | null;
                  win?.__retrohubResetAudio?.();
                  showFeedback('Fluxo de áudio reiniciado (anti-chiado).', 2400);
                } catch {
                  // ignore
                }
              }}
              title="Reiniciar áudio se estiver chiando ou dessincronizado"
              className="text-[11px] text-slate-400 hover:text-orange-300 pl-1 border-l border-white/10 transition-colors whitespace-nowrap"
            >
              Sinc. Som
            </button>
            {emuStatus === 'ready' && (
              <button
                type="button"
                onClick={() => {
                  const next = !vsyncEnabled;
                  setVsyncEnabled(next);
                  try {
                    const win = iframeRef.current?.contentWindow as
                      | (Window & {
                          EJS_emulator?: {
                            changeSettingOption?: (opt: string, val: string) => void;
                            gameManager?: { setVSync?: (enabled: boolean) => void };
                          };
                        })
                      | null;
                    win?.EJS_emulator?.changeSettingOption?.('vsync', next ? 'enabled' : 'disabled');
                    win?.EJS_emulator?.gameManager?.setVSync?.(next);
                    showFeedback(
                      next
                        ? 'VSync ativado (sincronia de vídeo padrão).'
                        : 'VSync desativado (reduz chiado em telas 90Hz/120Hz/144Hz).',
                      3000
                    );
                  } catch {
                    // ignore
                  }
                }}
                title="Alternar VSync (desativar ajuda em telas 120Hz/144Hz se o som picotar)"
                className={`text-[11px] pl-1 border-l border-white/10 transition-colors whitespace-nowrap ${
                  vsyncEnabled ? 'text-slate-400 hover:text-white' : 'text-amber-300'
                }`}
              >
                {vsyncEnabled ? 'VSync' : 'VSync Off'}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowTouchOverlay((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
              showTouchOverlay
                ? 'border-orange-500/50 bg-orange-500/15 text-orange-200'
                : 'border-white/10 text-slate-300 hover:bg-white/5'
            }`}
          >
            <Smartphone className="w-3.5 h-3.5" />
            Touch {showTouchOverlay ? 'Ativo' : 'Oculto'}
          </button>

          {showTouchOverlay && (
            <button
              type="button"
              onClick={() => setEditTouchLayout((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
                editTouchLayout
                  ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                  : 'border-white/10 text-slate-300 hover:bg-white/5'
              }`}
            >
              <Move className="w-3.5 h-3.5" />
              {editTouchLayout ? 'Concluir Layout' : 'Mover Botões'}
            </button>
          )}

          {consoleDef.supportsMouse && (
            <button
              type="button"
              onClick={() => {
                setMouseMode((v) => {
                  const next = !v;
                  showFeedback(
                    next
                      ? consoleDef.mouseNote || 'Modo Mouse / Light Gun ativo na tela do jogo.'
                      : 'Modo Mouse / Light Gun ocultado.',
                    3000
                  );
                  return next;
                });
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap ${
                mouseMode
                  ? 'border-sky-500/50 bg-sky-500/15 text-sky-200'
                  : 'border-white/10 text-slate-300 hover:bg-white/5'
              }`}
              title={consoleDef.mouseNote}
            >
              <MousePointer2 className="w-3.5 h-3.5" />
              Mouse / Light Gun
            </button>
          )}

          <button
            type="button"
            onClick={() => onOpenControlsConfig(consoleDef.id, gameId, gameName)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition-colors whitespace-nowrap"
          >
            <Settings className="w-3.5 h-3.5" />
            Controles
          </button>

          <button
            type="button"
            onClick={handleToggleFullscreen}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition-colors whitespace-nowrap"
          >
            {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            Tela Cheia
          </button>

          <button
            type="button"
            onClick={() => {
              setExitSaveError(null);
              setExitModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-600/90 hover:bg-red-600 text-white transition-colors whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sair
          </button>
        </div>
      </div>

      {/* Notices */}
      {gamepadNotice && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{gamepadNotice}</span>
        </div>
      )}

      {saveFeedback && (
        <div className="flex items-center justify-between px-4 py-2 rounded-lg border border-orange-500/30 bg-orange-500/10 text-orange-100 text-xs font-medium">
          <span>{saveFeedback}</span>
        </div>
      )}

      {editTouchLayout && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 rounded-lg border border-amber-400/30 bg-amber-500/10 text-xs text-amber-100">
          <span>
            {touchCenterWarn
              ? 'Área central do jogo protegida: os botões não podem cobrir o centro da tela.'
              : 'Modo de edição ativo: arraste o D-Pad e os botões virtuais para reposicioná-los.'}
          </span>
          <button
            type="button"
            onClick={handleResetTouchLayout}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-white font-medium"
          >
            <RotateCcw className="w-3 h-3" />
            Resetar Padrão
          </button>
        </div>
      )}

      {/* Main Emulator Viewport Stage */}
      <div
        ref={stageRef}
        className={`relative w-full overflow-hidden rounded-xl border border-white/10 bg-black ${
          isFullscreen ? 'h-screen rounded-none border-none' : 'h-[58vh] min-h-[380px] max-h-[760px]'
        }`}
      >
        {iframeSrcDoc && (
          <iframe
            ref={iframeRef}
            title={`${gameName} — ${consoleDef.name}`}
            srcDoc={iframeSrcDoc}
            allow="autoplay; gamepad; fullscreen"
            className={`w-full h-full border-0 ${editTouchLayout ? 'pointer-events-none' : ''}`}
          />
        )}

        {emuStatus === 'loading' && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-[#0B0D12]/80 backdrop-blur-xs text-center p-6">
            <div className="w-9 h-9 rounded-full border-2 border-orange-500 border-t-transparent animate-spin mb-3" />
            <p className="text-sm font-medium text-white">{statusMessage}</p>
            <p className="text-xs text-slate-400 mt-1">
              O núcleo WebAssembly é carregado direto no navegador.
            </p>
          </div>
        )}

        {emuStatus === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0B0D12]/95 text-center p-6">
            <AlertTriangle className="w-9 h-9 text-amber-400 mb-3" />
            <p className="text-sm font-semibold text-white max-w-md">{statusMessage}</p>
            <p className="text-xs text-slate-400 mt-2 max-w-md">
              Você ainda pode testar os controles, editar o layout touch e gerenciar seus slots de save.
            </p>
          </div>
        )}

        {showTouchOverlay && (
          <TouchControlsOverlay
            layout={profile.touch}
            opacity={profile.touchOpacity}
            editMode={editTouchLayout}
            avoidCenterZone={true}
            onLayoutChange={handleTouchLayoutChange}
            onActionPress={sendActionToEmulator}
            onCenterZoneWarning={setTouchCenterWarn}
          />
        )}
      </div>

      {/* 5-Slot Save State Bar (IndexedDB) */}
      <div className="rounded-xl border border-white/10 bg-[#141821] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-orange-400" />
            <h2 className="text-sm font-semibold text-white">
              Save States do Jogo (5 Slots via IndexedDB)
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={importInputRef}
              type="file"
              accept=".rhsave,.state,.bin,.json"
              onChange={handleImportSave}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 transition-colors whitespace-nowrap"
            >
              <Upload className="w-3.5 h-3.5" />
              Importar p/ Slot {activeSlot}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          {[1, 2, 3, 4, 5].map((slotNum) => {
            const rec = slots[slotNum - 1];
            const isActive = activeSlot === slotNum;
            return (
              <div
                key={slotNum}
                onClick={() => setActiveSlot(slotNum)}
                className={`rounded-lg border p-3 transition-colors cursor-pointer ${
                  isActive
                    ? 'border-orange-500/70 bg-orange-500/10'
                    : 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono-tabular text-xs font-semibold text-white">
                    Slot {slotNum}
                  </span>
                  <span className="text-[11px] font-mono-tabular text-slate-400">
                    {rec ? formatBytes(rec.sizeBytes) : 'Vazio'}
                  </span>
                </div>

                {rec?.screenshotDataUrl && (
                  <img
                    src={rec.screenshotDataUrl}
                    alt={`Preview Slot ${slotNum}`}
                    className="w-full h-16 object-cover rounded mb-2 border border-white/10"
                  />
                )}

                <div className="text-[11px] text-slate-400 font-mono-tabular mb-2.5 truncate">
                  {rec ? new Date(rec.updatedAt).toLocaleString('pt-BR') : 'Sem gravação'}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSaveSlot(slotNum);
                    }}
                    className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-orange-500 hover:bg-orange-600 text-white text-[11px] font-semibold transition-colors"
                  >
                    <Save className="w-3 h-3" />
                    Salvar
                  </button>
                  <button
                    type="button"
                    disabled={!rec}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleLoadSlot(slotNum);
                    }}
                    className="flex-1 px-2 py-1.5 rounded border border-white/10 text-slate-200 hover:bg-white/10 text-[11px] font-medium disabled:opacity-35 transition-colors"
                  >
                    Carregar
                  </button>
                  {rec && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        exportSaveStateFile(rec);
                      }}
                      title="Exportar Save State"
                      className="p-1.5 rounded border border-white/10 text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {rec && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSlot(slotNum);
                    }}
                    className="mt-1.5 w-full text-[11px] text-slate-500 hover:text-red-400 transition-colors text-right"
                  >
                    Limpar slot
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <ExitSaveModal
        open={exitModalOpen}
        gameName={gameName}
        consoleName={consoleDef.name}
        slots={slots}
        saving={savingBeforeExit}
        canSave={emuStatus === 'ready'}
        saveError={exitSaveError}
        onSaveAndExit={handleSaveAndExit}
        onExitWithoutSaving={() => {
          setExitSaveError(null);
          setExitModalOpen(false);
          onExit();
        }}
        onCancel={() => {
          setExitSaveError(null);
          setExitModalOpen(false);
        }}
      />
    </div>
  );
};
