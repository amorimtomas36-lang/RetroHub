import { ActionId, ConsoleDefinition } from '../data/consoles';

export type GamepadBinding =
  | { type: 'button'; index: number }
  | { type: 'axis'; index: number; direction: 1 | -1 };

export interface TouchButtonLayout {
  id: 'dpad' | ActionId;
  action: ActionId | 'dpad';
  label: string;
  xPct: number; // 0..100 center X percentage inside touch overlay container
  yPct: number; // 0..100 center Y percentage inside touch overlay container
  sizePx: number;
}

export interface ControlProfile {
  profileKey: string; // e.g. 'console:nes' or 'game:<gameId>'
  scope: 'console' | 'game';
  consoleId: string;
  gameId?: string;
  gameName?: string;
  keyboard: Record<ActionId, string>; // KeyboardEvent.code
  gamepad: Record<ActionId, GamepadBinding>;
  touch: TouchButtonLayout[];
  touchOpacity: number; // 0.35 .. 1.0
  updatedAt: number;
}

export const ACTION_CATALOG: Record<ActionId, { label: string; shortLabel: string }> = {
  up: { label: 'Direcional Cima', shortLabel: 'Cima' },
  down: { label: 'Direcional Baixo', shortLabel: 'Baixo' },
  left: { label: 'Direcional Esquerda', shortLabel: 'Esq' },
  right: { label: 'Direcional Direita', shortLabel: 'Dir' },
  a: { label: 'Pular / Confirmar (A)', shortLabel: 'A' },
  b: { label: 'Atirar / Ação (B)', shortLabel: 'B' },
  x: { label: 'Especial (X)', shortLabel: 'X' },
  y: { label: 'Correr / Atacar (Y)', shortLabel: 'Y' },
  l: { label: 'Ombro Esquerdo (L)', shortLabel: 'L' },
  r: { label: 'Ombro Direito (R)', shortLabel: 'R' },
  l2: { label: 'Gatilho Esquerdo (L2/Z)', shortLabel: 'L2' },
  r2: { label: 'Gatilho Direito (R2)', shortLabel: 'R2' },
  start: { label: 'Start / Pause', shortLabel: 'Start' },
  select: { label: 'Select / Ficha', shortLabel: 'Select' },
};

export const DEFAULT_KEYBOARD_MAP: Record<ActionId, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  a: 'KeyX',
  b: 'KeyZ',
  x: 'KeyS',
  y: 'KeyA',
  l: 'KeyQ',
  r: 'KeyW',
  l2: 'Digit1',
  r2: 'Digit2',
  start: 'Enter',
  select: 'ShiftRight',
};

export const DEFAULT_GAMEPAD_MAP: Record<ActionId, GamepadBinding> = {
  up: { type: 'button', index: 12 },
  down: { type: 'button', index: 13 },
  left: { type: 'button', index: 14 },
  right: { type: 'button', index: 15 },
  a: { type: 'button', index: 1 }, // East / Circle / A(Nintendo)
  b: { type: 'button', index: 0 }, // South / Cross / B(Nintendo)
  x: { type: 'button', index: 3 }, // North / Triangle / X(Nintendo)
  y: { type: 'button', index: 2 }, // West / Square / Y(Nintendo)
  l: { type: 'button', index: 4 },
  r: { type: 'button', index: 5 },
  l2: { type: 'button', index: 6 },
  r2: { type: 'button', index: 7 },
  start: { type: 'button', index: 9 },
  select: { type: 'button', index: 8 },
};

export function createDefaultTouchLayout(consoleDef?: ConsoleDefinition): TouchButtonLayout[] {
  const activeActions = new Set<ActionId>(
    consoleDef?.actions ?? ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select']
  );

  const items: TouchButtonLayout[] = [
    {
      id: 'dpad',
      action: 'dpad',
      label: 'D-Pad',
      xPct: 16,
      yPct: 72,
      sizePx: 124,
    },
  ];

  const candidates: { id: ActionId; xPct: number; yPct: number; sizePx: number }[] = [
    { id: 'b', xPct: 80, yPct: 78, sizePx: 54 },
    { id: 'a', xPct: 90, yPct: 68, sizePx: 54 },
    { id: 'y', xPct: 70, yPct: 68, sizePx: 52 },
    { id: 'x', xPct: 80, yPct: 58, sizePx: 52 },
    { id: 'l', xPct: 11, yPct: 22, sizePx: 48 },
    { id: 'r', xPct: 89, yPct: 22, sizePx: 48 },
    { id: 'l2', xPct: 22, yPct: 22, sizePx: 46 },
    { id: 'r2', xPct: 78, yPct: 22, sizePx: 46 },
    { id: 'select', xPct: 40, yPct: 88, sizePx: 46 },
    { id: 'start', xPct: 60, yPct: 88, sizePx: 46 },
  ];

  for (const item of candidates) {
    if (activeActions.has(item.id)) {
      items.push({
        id: item.id,
        action: item.id,
        label: ACTION_CATALOG[item.id].shortLabel,
        xPct: item.xPct,
        yPct: item.yPct,
        sizePx: item.sizePx,
      });
    }
  }

  return items;
}

export function createDefaultProfile(
  consoleDef: ConsoleDefinition,
  gameId?: string,
  gameName?: string
): ControlProfile {
  const scope = gameId ? 'game' : 'console';
  return {
    profileKey: gameId ? `game:${gameId}` : `console:${consoleDef.id}`,
    scope,
    consoleId: consoleDef.id,
    gameId,
    gameName,
    keyboard: { ...DEFAULT_KEYBOARD_MAP },
    gamepad: Object.fromEntries(
      Object.entries(DEFAULT_GAMEPAD_MAP).map(([k, v]) => [k, { ...v }])
    ) as Record<ActionId, GamepadBinding>,
    touch: createDefaultTouchLayout(consoleDef),
    touchOpacity: 0.78,
    updatedAt: Date.now(),
  };
}

export function formatKeyCode(code: string): string {
  if (!code) return 'Não definido';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ArrowUp: 'Seta ↑',
    ArrowDown: 'Seta ↓',
    ArrowLeft: 'Seta ←',
    ArrowRight: 'Seta →',
    Space: 'Espaço',
    Enter: 'Enter',
    ShiftLeft: 'Shift Esq',
    ShiftRight: 'Shift Dir',
    ControlLeft: 'Ctrl Esq',
    ControlRight: 'Ctrl Dir',
    AltLeft: 'Alt Esq',
    AltRight: 'Alt Dir',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Esc',
  };
  return map[code] ?? code;
}

export function formatGamepadBinding(binding: GamepadBinding): string {
  if (binding.type === 'axis') {
    return `Eixo ${binding.index} ${binding.direction > 0 ? '+' : '−'}`;
  }
  const standardNames: Record<number, string> = {
    0: 'Botão 0 (A / ✕)',
    1: 'Botão 1 (B / ○)',
    2: 'Botão 2 (X / □)',
    3: 'Botão 3 (Y / △)',
    4: 'Botão 4 (LB / L1)',
    5: 'Botão 5 (RB / R1)',
    6: 'Botão 6 (LT / L2)',
    7: 'Botão 7 (RT / R2)',
    8: 'Botão 8 (Select / View)',
    9: 'Botão 9 (Start / Menu)',
    10: 'Botão 10 (L3)',
    11: 'Botão 11 (R3)',
    12: 'D-Pad Cima',
    13: 'D-Pad Baixo',
    14: 'D-Pad Esquerda',
    15: 'D-Pad Direita',
  };
  return standardNames[binding.index] ?? `Botão ${binding.index}`;
}

export function isSameGamepadBinding(a: GamepadBinding, b: GamepadBinding): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'button' && b.type === 'button') return a.index === b.index;
  if (a.type === 'axis' && b.type === 'axis') {
    return a.index === b.index && a.direction === b.direction;
  }
  return false;
}

export function findKeyboardCollision(
  keyboard: Record<ActionId, string>,
  targetAction: ActionId,
  newCode: string,
  allowedActions: ActionId[]
): ActionId | null {
  for (const act of allowedActions) {
    if (act !== targetAction && keyboard[act] === newCode) {
      return act;
    }
  }
  return null;
}

export function findGamepadCollision(
  gamepad: Record<ActionId, GamepadBinding>,
  targetAction: ActionId,
  newBinding: GamepadBinding,
  allowedActions: ActionId[]
): ActionId | null {
  for (const act of allowedActions) {
    if (act !== targetAction && isSameGamepadBinding(gamepad[act], newBinding)) {
      return act;
    }
  }
  return null;
}

/**
 * Clamps a draggable touch control strictly inside the container bounds and warns/avoids
 * covering the protected center game screen area when container dimensions are known.
 */
export function clampTouchPosition(
  rawXPct: number,
  rawYPct: number,
  sizePx: number,
  containerWidth: number,
  containerHeight: number,
  avoidCenterGameZone = true
): { xPct: number; yPct: number; adjustedFromCenter: boolean } {
  const w = Math.max(containerWidth, 240);
  const h = Math.max(containerHeight, 180);
  const marginX = Math.min(((sizePx / 2 + 8) / w) * 100, 45);
  const marginY = Math.min(((sizePx / 2 + 8) / h) * 100, 45);

  let xPct = Math.min(Math.max(rawXPct, marginX), 100 - marginX);
  let yPct = Math.min(Math.max(rawYPct, marginY), 100 - marginY);
  let adjustedFromCenter = false;

  // Center safe-zone guard: keep controls out of the central 32%..68% X and 22%..66% Y area
  if (avoidCenterGameZone) {
    const inCenterX = xPct > 32 && xPct < 68;
    const inCenterY = yPct > 22 && yPct < 66;
    if (inCenterX && inCenterY) {
      adjustedFromCenter = true;
      const distLeft = Math.abs(xPct - 32);
      const distRight = Math.abs(68 - xPct);
      const distTop = Math.abs(yPct - 22);
      const distBottom = Math.abs(66 - yPct);
      const minD = Math.min(distLeft, distRight, distTop, distBottom);
      if (minD === distBottom) yPct = 66;
      else if (minD === distLeft) xPct = 32;
      else if (minD === distRight) xPct = 68;
      else yPct = 22;
    }
  }

  // Re-clamp strictly inside viewport bounds even on narrow portrait containers
  xPct = Math.min(Math.max(xPct, marginX), 100 - marginX);
  yPct = Math.min(Math.max(yPct, marginY), 100 - marginY);

  return {
    xPct: Number(xPct.toFixed(1)),
    yPct: Number(yPct.toFixed(1)),
    adjustedFromCenter,
  };
}

/**
 * Translates KeyboardEvent.code into keyCode integer expected by EmulatorJS / RetroArch Web.
 */
export function codeToKeyCode(code: string): number {
  const table: Record<string, number> = {
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Enter: 13,
    Space: 32,
    ShiftLeft: 16,
    ShiftRight: 16,
    ControlLeft: 17,
    ControlRight: 17,
    AltLeft: 18,
    AltRight: 18,
    Tab: 9,
    Backspace: 8,
    Escape: 27,
  };
  if (table[code]) return table[code];
  if (code.startsWith('Key') && code.length === 4) {
    return code.charCodeAt(3);
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.charCodeAt(5);
  }
  return 0;
}

export function codeToEjsKeyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ArrowUp: 'up arrow',
    ArrowDown: 'down arrow',
    ArrowLeft: 'left arrow',
    ArrowRight: 'right arrow',
    Enter: 'enter',
    Space: 'space',
    ShiftLeft: 'shift',
    ShiftRight: 'shift',
    ControlLeft: 'ctrl',
    ControlRight: 'ctrl',
  };
  return map[code] ?? code.toLowerCase();
}
