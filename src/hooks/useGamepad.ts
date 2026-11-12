import { useEffect, useRef, useState } from 'react';
import { ActionId } from '../data/consoles';
import { GamepadBinding } from '../utils/controls';

export interface ConnectedGamepadInfo {
  index: number;
  id: string;
  buttonsCount: number;
  axesCount: number;
  mapping: string;
}

interface UseGamepadOptions {
  enabled?: boolean;
  bindings?: Record<ActionId, GamepadBinding>;
  allowedActions?: ActionId[];
  onActionStateChange?: (action: ActionId, pressed: boolean) => void;
  onDisconnectNotice?: (gamepadId: string) => void;
  captureActive?: boolean;
  onCaptureInput?: (binding: GamepadBinding) => void;
}

export function useGamepad({
  enabled = true,
  bindings,
  allowedActions,
  onActionStateChange,
  onDisconnectNotice,
  captureActive = false,
  onCaptureInput,
}: UseGamepadOptions = {}) {
  const [gamepads, setGamepads] = useState<ConnectedGamepadInfo[]>([]);
  const pressedStateRef = useRef<Partial<Record<ActionId, boolean>>>({});
  const captureBaselineRef = useRef<Map<number, { buttons: boolean[]; axes: number[] }>>(new Map());
  const callbacksRef = useRef({ onActionStateChange, onDisconnectNotice, onCaptureInput });
  callbacksRef.current = { onActionStateChange, onDisconnectNotice, onCaptureInput };

  const releaseAllPressed = () => {
    const prev = pressedStateRef.current;
    for (const key of Object.keys(prev) as ActionId[]) {
      if (prev[key]) {
        prev[key] = false;
        callbacksRef.current.onActionStateChange?.(key, false);
      }
    }
  };

  useEffect(() => {
    const syncList = () => {
      if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
      const pads = Array.from(navigator.getGamepads()).filter((g): g is Gamepad => Boolean(g && g.connected));
      setGamepads(
        pads.map((g) => ({
          index: g.index,
          id: g.id,
          buttonsCount: g.buttons.length,
          axesCount: g.axes.length,
          mapping: g.mapping || 'custom',
        }))
      );
    };

    const handleConnect = () => syncList();
    const handleDisconnect = (e: GamepadEvent) => {
      releaseAllPressed();
      syncList();
      callbacksRef.current.onDisconnectNotice?.(e.gamepad.id);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        releaseAllPressed();
      }
    };

    const handleBlur = () => {
      releaseAllPressed();
    };

    window.addEventListener('gamepadconnected', handleConnect);
    window.addEventListener('gamepaddisconnected', handleDisconnect);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);
    syncList();

    return () => {
      releaseAllPressed();
      window.removeEventListener('gamepadconnected', handleConnect);
      window.removeEventListener('gamepaddisconnected', handleDisconnect);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  // Capture baseline when captureActive turns on so already-held triggers don't immediately fire
  useEffect(() => {
    if (!captureActive) {
      captureBaselineRef.current.clear();
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const map = new Map<number, { buttons: boolean[]; axes: number[] }>();
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      map.set(gp.index, {
        buttons: gp.buttons.map((b) => b.pressed || b.value > 0.5),
        axes: Array.from(gp.axes),
      });
    }
    captureBaselineRef.current = map;
  }, [captureActive]);

  useEffect(() => {
    if (!enabled && !captureActive) {
      releaseAllPressed();
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    let rafId = 0;

    const tick = () => {
      const pads = navigator.getGamepads();
      const connectedPads = Array.from(pads).filter((g): g is Gamepad => Boolean(g && g.connected));

      // Capture mode: detect first newly pressed button or pushed analog axis
      if (captureActive && connectedPads.length > 0) {
        for (const gp of connectedPads) {
          const base = captureBaselineRef.current.get(gp.index);
          for (let i = 0; i < gp.buttons.length; i++) {
            const isPressed = gp.buttons[i].pressed || gp.buttons[i].value > 0.5;
            const wasPressed = base?.buttons[i] ?? false;
            if (isPressed && !wasPressed) {
              callbacksRef.current.onCaptureInput?.({ type: 'button', index: i });
              return;
            }
          }
          for (let a = 0; a < gp.axes.length; a++) {
            const val = gp.axes[a];
            const baseVal = base?.axes[a] ?? 0;
            if (Math.abs(val) > 0.78 && Math.abs(val - baseVal) > 0.45 && Math.abs(baseVal) < 0.4) {
              callbacksRef.current.onCaptureInput?.({
                type: 'axis',
                index: a,
                direction: val > 0 ? 1 : -1,
              });
              return;
            }
          }
        }
      }

      // Live gameplay mapping mode
      if (enabled && !captureActive && bindings && allowedActions && !document.hidden) {
        const primary = connectedPads[0];
        if (primary) {
          for (const action of allowedActions) {
            const bind = bindings[action];
            if (!bind) continue;
            let isNowPressed = false;
            if (bind.type === 'button') {
              const btn = primary.buttons[bind.index];
              isNowPressed = Boolean(btn && (btn.pressed || btn.value > 0.5));
            } else if (bind.type === 'axis') {
              const ax = primary.axes[bind.index] ?? 0;
              isNowPressed = bind.direction > 0 ? ax > 0.45 : ax < -0.45;
            }

            // Also map Left Analog Stick (axes 0 & 1) smoothly to D-Pad directions
            if (!isNowPressed) {
              if (action === 'left' && (primary.axes[0] ?? 0) < -0.45) isNowPressed = true;
              if (action === 'right' && (primary.axes[0] ?? 0) > 0.45) isNowPressed = true;
              if (action === 'up' && (primary.axes[1] ?? 0) < -0.45) isNowPressed = true;
              if (action === 'down' && (primary.axes[1] ?? 0) > 0.45) isNowPressed = true;
            }

            if (Boolean(pressedStateRef.current[action]) !== isNowPressed) {
              pressedStateRef.current[action] = isNowPressed;
              callbacksRef.current.onActionStateChange?.(action, isNowPressed);
            }
          }
        } else {
          releaseAllPressed();
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      releaseAllPressed();
    };
  }, [enabled, captureActive, bindings, allowedActions]);

  return { gamepads };
}
