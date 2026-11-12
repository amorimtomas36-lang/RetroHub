import React, { useEffect, useRef, useState } from 'react';
import { ActionId } from '../data/consoles';
import { clampTouchPosition, TouchButtonLayout } from '../utils/controls';

interface TouchControlsOverlayProps {
  layout: TouchButtonLayout[];
  opacity: number;
  editMode: boolean;
  avoidCenterZone?: boolean;
  selectedId?: string | null;
  onSelectButton?: (id: string) => void;
  onLayoutChange?: (nextLayout: TouchButtonLayout[]) => void;
  onActionPress?: (action: ActionId, pressed: boolean) => void;
  onCenterZoneWarning?: (warned: boolean) => void;
}

export const TouchControlsOverlay: React.FC<TouchControlsOverlayProps> = ({
  layout,
  opacity,
  editMode,
  avoidCenterZone = true,
  selectedId,
  onSelectButton,
  onLayoutChange,
  onActionPress,
  onCenterZoneWarning,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeButtons, setActiveButtons] = useState<Record<string, boolean>>({});
  const [dpadDirs, setDpadDirs] = useState<{ up: boolean; down: boolean; left: boolean; right: boolean }>({
    up: false,
    down: false,
    left: false,
    right: false,
  });
  const dpadStateRef = useRef({ up: false, down: false, left: false, right: false });
  const dpadPointerIdRef = useRef<number | null>(null);
  const heldButtonsRef = useRef<Map<string, ActionId>>(new Map());
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const callbacksRef = useRef({ onActionPress, onLayoutChange });
  callbacksRef.current = { onActionPress, onLayoutChange };
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origXPct: number;
    origYPct: number;
    sizePx: number;
  } | null>(null);

  const releaseAll = () => {
    dpadPointerIdRef.current = null;
    if (heldButtonsRef.current.size > 0) {
      heldButtonsRef.current.forEach((act) => {
        callbacksRef.current.onActionPress?.(act, false);
      });
      heldButtonsRef.current.clear();
    }
    setActiveButtons({});
    setDpadDirs({ up: false, down: false, left: false, right: false });
    (['up', 'down', 'left', 'right'] as ActionId[]).forEach((dir) => {
      if (dpadStateRef.current[dir as keyof typeof dpadStateRef.current]) {
        dpadStateRef.current[dir as keyof typeof dpadStateRef.current] = false;
        callbacksRef.current.onActionPress?.(dir, false);
      }
    });
  };

  // Release any held touch inputs if visibility changes, window blurs, or entering edit mode
  useEffect(() => {
    if (editMode) releaseAll();
  }, [editMode]);

  useEffect(() => {
    const handleVis = () => {
      if (document.hidden) releaseAll();
    };
    const handleBlur = () => releaseAll();
    const handleResize = () => {
      if (!containerRef.current || !callbacksRef.current.onLayoutChange) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) return;
      let changed = false;
      const clamped = layoutRef.current.map((btn) => {
        const res = clampTouchPosition(btn.xPct, btn.yPct, btn.sizePx, rect.width, rect.height, false);
        if (res.xPct !== btn.xPct || res.yPct !== btn.yPct) {
          changed = true;
          return { ...btn, xPct: res.xPct, yPct: res.yPct };
        }
        return btn;
      });
      if (changed) callbacksRef.current.onLayoutChange(clamped);
    };

    document.addEventListener('visibilitychange', handleVis);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      releaseAll();
      document.removeEventListener('visibilitychange', handleVis);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, []);

  const updateDpadFromPointer = (clientX: number, clientY: number, el: HTMLDivElement) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const deadzone = rect.width * 0.14;

    const next = {
      up: dy < -deadzone,
      down: dy > deadzone,
      left: dx < -deadzone,
      right: dx > deadzone,
    };

    (['up', 'down', 'left', 'right'] as const).forEach((dir) => {
      if (dpadStateRef.current[dir] !== next[dir]) {
        dpadStateRef.current[dir] = next[dir];
        onActionPress?.(dir, next[dir]);
      }
    });
    setDpadDirs(next);
  };

  const clearDpad = () => {
    dpadPointerIdRef.current = null;
    (['up', 'down', 'left', 'right'] as const).forEach((dir) => {
      if (dpadStateRef.current[dir]) {
        dpadStateRef.current[dir] = false;
        onActionPress?.(dir, false);
      }
    });
    setDpadDirs({ up: false, down: false, left: false, right: false });
  };

  const handleEditPointerDown = (e: React.PointerEvent, item: TouchButtonLayout) => {
    if (!editMode) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onSelectButton?.(item.id);
    dragRef.current = {
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      origXPct: item.xPct,
      origYPct: item.yPct,
      sizePx: item.sizePx,
    };
  };

  const handleEditPointerMove = (e: React.PointerEvent) => {
    if (!editMode || !dragRef.current || !containerRef.current || !onLayoutChange) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dxPct = ((e.clientX - dragRef.current.startX) / rect.width) * 100;
    const dyPct = ((e.clientY - dragRef.current.startY) / rect.height) * 100;

    const rawX = dragRef.current.origXPct + dxPct;
    const rawY = dragRef.current.origYPct + dyPct;

    const { xPct, yPct, adjustedFromCenter } = clampTouchPosition(
      rawX,
      rawY,
      dragRef.current.sizePx,
      rect.width,
      rect.height,
      avoidCenterZone
    );
    onCenterZoneWarning?.(adjustedFromCenter);

    const targetId = dragRef.current.id;
    onLayoutChange(
      layout.map((btn) => (btn.id === targetId ? { ...btn, xPct, yPct } : btn))
    );
  };

  const handleEditPointerUp = () => {
    dragRef.current = null;
    onCenterZoneWarning?.(false);
  };

  return (
    <div
      ref={containerRef}
      className={`touch-control-surface absolute inset-0 z-20 ${
        editMode ? 'pointer-events-auto cursor-move' : 'pointer-events-none'
      }`}
    >
      {editMode && avoidCenterZone && (
        <div
          className="pointer-events-none absolute border border-dashed border-amber-400/40 bg-amber-500/5 rounded-lg flex items-center justify-center"
          style={{ left: '32%', top: '22%', width: '36%', height: '44%' }}
        >
          <span className="text-[11px] font-medium text-amber-300/80 px-2 py-1 bg-black/60 rounded">
            Área protegida do jogo
          </span>
        </div>
      )}

      {layout.map((item) => {
        const isSelected = editMode && selectedId === item.id;

        if (item.action === 'dpad') {
          return (
            <div
              key={item.id}
              onPointerDown={(e) => {
                if (editMode) {
                  handleEditPointerDown(e, item);
                  return;
                }
                e.stopPropagation();
                e.preventDefault();
                dpadPointerIdRef.current = e.pointerId;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                updateDpadFromPointer(e.clientX, e.clientY, e.currentTarget as HTMLDivElement);
              }}
              onPointerMove={(e) => {
                if (editMode) {
                  handleEditPointerMove(e);
                  return;
                }
                if (dpadPointerIdRef.current === e.pointerId) {
                  updateDpadFromPointer(e.clientX, e.clientY, e.currentTarget as HTMLDivElement);
                }
              }}
              onPointerUp={(e) => {
                if (editMode) handleEditPointerUp();
                else if (dpadPointerIdRef.current === e.pointerId) clearDpad();
              }}
              onPointerCancel={(e) => {
                if (editMode) handleEditPointerUp();
                else if (dpadPointerIdRef.current === e.pointerId) clearDpad();
              }}
              style={{
                left: `${item.xPct}%`,
                top: `${item.yPct}%`,
                width: `${item.sizePx}px`,
                height: `${item.sizePx}px`,
                opacity: editMode ? 0.95 : opacity,
              }}
              className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full border backdrop-blur-sm transition-shadow flex items-center justify-center ${
                isSelected
                  ? 'border-orange-400 ring-2 ring-orange-500/50 bg-slate-900/85'
                  : 'border-white/20 bg-slate-950/65'
              }`}
              aria-label="Direcional D-Pad"
            >
              {/* Cross D-Pad visual */}
              <div className="relative w-[76%] h-[76%]">
                <div
                  className={`absolute left-[34%] top-0 w-[32%] h-[36%] rounded-t-md border border-white/20 flex items-center justify-center text-[10px] ${
                    dpadDirs.up ? 'bg-orange-500 text-white' : 'bg-slate-800/90 text-slate-300'
                  }`}
                >
                  ▲
                </div>
                <div
                  className={`absolute left-[34%] bottom-0 w-[32%] h-[36%] rounded-b-md border border-white/20 flex items-center justify-center text-[10px] ${
                    dpadDirs.down ? 'bg-orange-500 text-white' : 'bg-slate-800/90 text-slate-300'
                  }`}
                >
                  ▼
                </div>
                <div
                  className={`absolute left-0 top-[34%] w-[36%] h-[32%] rounded-l-md border border-white/20 flex items-center justify-center text-[10px] ${
                    dpadDirs.left ? 'bg-orange-500 text-white' : 'bg-slate-800/90 text-slate-300'
                  }`}
                >
                  ◀
                </div>
                <div
                  className={`absolute right-0 top-[34%] w-[36%] h-[32%] rounded-r-md border border-white/20 flex items-center justify-center text-[10px] ${
                    dpadDirs.right ? 'bg-orange-500 text-white' : 'bg-slate-800/90 text-slate-300'
                  }`}
                >
                  ▶
                </div>
                <div className="absolute left-[34%] top-[34%] w-[32%] h-[32%] bg-slate-800/95" />
              </div>
              {editMode && (
                <span className="absolute -bottom-5 text-[10px] font-mono-tabular bg-black/80 text-orange-300 px-1.5 py-0.5 rounded whitespace-nowrap">
                  D-Pad
                </span>
              )}
            </div>
          );
        }

        const actionId = item.action;
        const isPressed = Boolean(activeButtons[item.id]);
        const isWide = item.id === 'start' || item.id === 'select' || item.id === 'l' || item.id === 'r' || item.id === 'l2' || item.id === 'r2';

        return (
          <button
            key={item.id}
            type="button"
            onPointerDown={(e) => {
              if (editMode) {
                handleEditPointerDown(e, item);
                return;
              }
              e.stopPropagation();
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              heldButtonsRef.current.set(item.id, actionId);
              setActiveButtons((prev) => ({ ...prev, [item.id]: true }));
              onActionPress?.(actionId, true);
            }}
            onPointerMove={(e) => {
              if (editMode) handleEditPointerMove(e);
            }}
            onPointerUp={(e) => {
              if (editMode) {
                handleEditPointerUp();
                return;
              }
              e.stopPropagation();
              heldButtonsRef.current.delete(item.id);
              setActiveButtons((prev) => ({ ...prev, [item.id]: false }));
              onActionPress?.(actionId, false);
            }}
            onPointerCancel={() => {
              if (editMode) {
                handleEditPointerUp();
                return;
              }
              heldButtonsRef.current.delete(item.id);
              setActiveButtons((prev) => ({ ...prev, [item.id]: false }));
              onActionPress?.(actionId, false);
            }}
            style={{
              left: `${item.xPct}%`,
              top: `${item.yPct}%`,
              width: isWide ? `${Math.round(item.sizePx * 1.35)}px` : `${item.sizePx}px`,
              height: isWide ? `${Math.round(item.sizePx * 0.72)}px` : `${item.sizePx}px`,
              opacity: editMode ? 0.95 : opacity,
            }}
            className={`pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center font-display font-semibold text-xs border backdrop-blur-sm transition-transform ${
              isWide ? 'rounded-xl' : 'rounded-full'
            } ${
              isSelected
                ? 'border-orange-400 ring-2 ring-orange-500/50 bg-orange-600/40 text-white'
                : isPressed
                ? 'scale-95 bg-orange-500 border-orange-300 text-white'
                : 'bg-slate-900/70 border-white/25 text-slate-100 hover:bg-slate-800/80'
            }`}
            aria-label={`Botão virtual ${item.label}`}
          >
            <span className="truncate px-1">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
};
