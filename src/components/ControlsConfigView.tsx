import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Gamepad2,
  Keyboard,
  Move,
  RotateCcw,
  Smartphone,
} from 'lucide-react';
import { ActionId, CONSOLES, ConsoleDefinition, getConsoleById } from '../data/consoles';
import { useGamepad } from '../hooks/useGamepad';
import {
  ACTION_CATALOG,
  ControlProfile,
  GamepadBinding,
  createDefaultProfile,
  createDefaultTouchLayout,
  findGamepadCollision,
  findKeyboardCollision,
  formatGamepadBinding,
  formatKeyCode,
} from '../utils/controls';
import {
  deleteGameControlProfile,
  loadControlProfileSync,
  saveControlProfile,
} from '../utils/indexedDb';
import { TouchControlsOverlay } from './TouchControlsOverlay';

interface ControlsConfigViewProps {
  initialConsoleId?: string;
  activeGameContext?: { gameId: string; gameName: string; consoleId: string } | null;
  onBackToGame?: () => void;
}

type InputTab = 'keyboard' | 'gamepad' | 'touch';

export const ControlsConfigView: React.FC<ControlsConfigViewProps> = ({
  initialConsoleId = 'snes',
  activeGameContext,
  onBackToGame,
}) => {
  const [selectedConsoleId, setSelectedConsoleId] = useState<string>(
    activeGameContext?.consoleId ?? initialConsoleId
  );
  const [profileScope, setProfileScope] = useState<'console' | 'game'>(
    activeGameContext ? 'game' : 'console'
  );
  const [activeTab, setActiveTab] = useState<InputTab>('keyboard');

  const consoleDef: ConsoleDefinition = useMemo(
    () => getConsoleById(selectedConsoleId) ?? CONSOLES[0],
    [selectedConsoleId]
  );

  const isGameScopeActive =
    profileScope === 'game' && activeGameContext?.consoleId === consoleDef.id;

  const effectiveGameId = isGameScopeActive ? activeGameContext?.gameId : undefined;
  const effectiveGameName = isGameScopeActive ? activeGameContext?.gameName : undefined;

  const [profile, setProfile] = useState<ControlProfile>(() =>
    loadControlProfileSync(consoleDef, effectiveGameId, effectiveGameName)
  );

  // Sync profile when console or scope changes
  useEffect(() => {
    setProfile(loadControlProfileSync(consoleDef, effectiveGameId, effectiveGameName));
    setCapturingAction(null);
    setCollisionAlert(null);
    setSelectedTouchId('dpad');
  }, [consoleDef, effectiveGameId, effectiveGameName]);

  const [capturingAction, setCapturingAction] = useState<ActionId | null>(null);
  const [collisionAlert, setCollisionAlert] = useState<{
    mode: 'keyboard' | 'gamepad';
    targetAction: ActionId;
    conflictAction: ActionId;
    newKeyboardCode?: string;
    newGamepadBinding?: GamepadBinding;
    label: string;
  } | null>(null);

  const [savedToast, setSavedToast] = useState<string | null>(null);
  const toastTimerRef = React.useRef<number | null>(null);
  const [previewOrientation, setPreviewOrientation] = useState<'landscape' | 'portrait'>('landscape');
  const [selectedTouchId, setSelectedTouchId] = useState<string | null>('dpad');
  const [centerWarn, setCenterWarn] = useState(false);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const persistProfile = (next: ControlProfile, toastMsg?: string) => {
    setProfile(next);
    saveControlProfile(next);
    if (toastMsg) {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
      setSavedToast(toastMsg);
      toastTimerRef.current = window.setTimeout(() => setSavedToast(null), 2200);
    }
  };

  const getActionLabel = (action: ActionId) => {
    return consoleDef.buttonLabels?.[action] ?? ACTION_CATALOG[action].label;
  };

  // Keyboard capture listener
  useEffect(() => {
    if (activeTab !== 'keyboard' || !capturingAction) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.code === 'Escape') {
        setCapturingAction(null);
        return;
      }

      if (!e.code) return;

      const conflict = findKeyboardCollision(
        profile.keyboard,
        capturingAction,
        e.code,
        consoleDef.actions
      );

      if (conflict) {
        setCollisionAlert({
          mode: 'keyboard',
          targetAction: capturingAction,
          conflictAction: conflict,
          newKeyboardCode: e.code,
          label: formatKeyCode(e.code),
        });
        setCapturingAction(null);
        return;
      }

      const next: ControlProfile = {
        ...profile,
        keyboard: {
          ...profile.keyboard,
          [capturingAction]: e.code,
        },
      };
      setCapturingAction(null);
      setCollisionAlert(null);
      persistProfile(next, `Tecla ${formatKeyCode(e.code)} atribuída a "${getActionLabel(capturingAction)}".`);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [activeTab, capturingAction, profile, consoleDef]);

  // Gamepad capture via Gamepad API
  const { gamepads } = useGamepad({
    enabled: false,
    captureActive: activeTab === 'gamepad' && Boolean(capturingAction),
    onCaptureInput: (binding) => {
      if (!capturingAction) return;
      const conflict = findGamepadCollision(
        profile.gamepad,
        capturingAction,
        binding,
        consoleDef.actions
      );

      if (conflict) {
        setCollisionAlert({
          mode: 'gamepad',
          targetAction: capturingAction,
          conflictAction: conflict,
          newGamepadBinding: binding,
          label: formatGamepadBinding(binding),
        });
        setCapturingAction(null);
        return;
      }

      const next: ControlProfile = {
        ...profile,
        gamepad: {
          ...profile.gamepad,
          [capturingAction]: binding,
        },
      };
      setCapturingAction(null);
      setCollisionAlert(null);
      persistProfile(
        next,
        `${formatGamepadBinding(binding)} atribuído a "${getActionLabel(capturingAction)}".`
      );
    },
  });

  const handleConfirmSwapCollision = () => {
    if (!collisionAlert) return;
    if (collisionAlert.mode === 'keyboard' && collisionAlert.newKeyboardCode) {
      const prevCodeOfTarget = profile.keyboard[collisionAlert.targetAction];
      const next: ControlProfile = {
        ...profile,
        keyboard: {
          ...profile.keyboard,
          [collisionAlert.targetAction]: collisionAlert.newKeyboardCode,
          [collisionAlert.conflictAction]: prevCodeOfTarget,
        },
      };
      persistProfile(
        next,
        `Teclas trocadas entre "${getActionLabel(collisionAlert.targetAction)}" e "${getActionLabel(
          collisionAlert.conflictAction
        )}".`
      );
    } else if (collisionAlert.mode === 'gamepad' && collisionAlert.newGamepadBinding) {
      const prevBindOfTarget = profile.gamepad[collisionAlert.targetAction];
      const next: ControlProfile = {
        ...profile,
        gamepad: {
          ...profile.gamepad,
          [collisionAlert.targetAction]: collisionAlert.newGamepadBinding,
          [collisionAlert.conflictAction]: prevBindOfTarget,
        },
      };
      persistProfile(
        next,
        `Botões trocados entre "${getActionLabel(collisionAlert.targetAction)}" e "${getActionLabel(
          collisionAlert.conflictAction
        )}".`
      );
    }
    setCollisionAlert(null);
  };

  const handleResetAllDefaults = async () => {
    if (effectiveGameId) {
      await deleteGameControlProfile(effectiveGameId);
    }
    const fresh = createDefaultProfile(consoleDef, effectiveGameId, effectiveGameName);
    persistProfile(fresh, 'Controles restaurados para o padrão de fábrica.');
    setCollisionAlert(null);
    setCapturingAction(null);
  };

  const selectedTouchButton = profile.touch.find((t) => t.id === selectedTouchId);

  const handleTouchActionReassign = (btnId: string, newAction: ActionId) => {
    const duplicate = profile.touch.find((t) => t.id !== btnId && t.action === newAction);
    const current = profile.touch.find((t) => t.id === btnId);
    if (!current || current.action === 'dpad') return;

    const updatedTouch = profile.touch.map((t) => {
      if (t.id === btnId) {
        return {
          ...t,
          action: newAction,
          label: ACTION_CATALOG[newAction].shortLabel,
        };
      }
      // Swap automatically if another virtual button already had this action so no action becomes unbound
      if (duplicate && t.id === duplicate.id && current.action !== 'dpad') {
        return {
          ...t,
          action: current.action,
          label: ACTION_CATALOG[current.action].shortLabel,
        };
      }
      return t;
    });

    persistProfile(
      { ...profile, touch: updatedTouch },
      duplicate
        ? `Ação trocada com o botão "${duplicate.label}" para evitar duplicidade.`
        : `Botão virtual agora dispara "${getActionLabel(newAction)}".`
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Configurar Controles
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Mapeie ações para Teclado (PC), Controle Bluetooth/USB e botões Touch com salvamento automático por console ou jogo.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {onBackToGame && activeGameContext && (
            <button
              type="button"
              onClick={onBackToGame}
              className="px-4 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold transition-colors whitespace-nowrap"
            >
              Voltar ao Jogo
            </button>
          )}
          <button
            type="button"
            onClick={handleResetAllDefaults}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/10 text-sm font-medium text-slate-200 hover:bg-white/5 transition-colors whitespace-nowrap"
          >
            <RotateCcw className="w-4 h-4" />
            Resetar Padrão
          </button>
        </div>
      </div>

      {/* Console & Profile Scope Selector */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 rounded-xl border border-white/10 bg-[#141821]">
        <div>
          <label htmlFor="ctrl-console-select" className="block text-xs font-medium text-slate-400 mb-1.5">
            Console alvo
          </label>
          <select
            id="ctrl-console-select"
            value={consoleDef.id}
            onChange={(e) => setSelectedConsoleId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-[#0B0D12] border border-white/10 text-sm text-white focus:outline-none focus:border-orange-500"
          >
            {CONSOLES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.manufacturer}, {c.year})
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="block text-xs font-medium text-slate-400 mb-1.5">Escopo do perfil salvo</span>
          <div className="flex items-center gap-2 p-1 rounded-lg bg-[#0B0D12] border border-white/10">
            <button
              type="button"
              onClick={() => setProfileScope('console')}
              className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                !isGameScopeActive
                  ? 'bg-orange-500 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Padrão do {consoleDef.shortName}
            </button>
            <button
              type="button"
              disabled={!activeGameContext || activeGameContext.consoleId !== consoleDef.id}
              onClick={() => setProfileScope('game')}
              className={`flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors truncate disabled:opacity-40 ${
                isGameScopeActive
                  ? 'bg-orange-500 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
              title={
                activeGameContext
                  ? `Perfil exclusivo para ${activeGameContext.gameName}`
                  : 'Carregue um jogo para criar perfil exclusivo'
              }
            >
              {activeGameContext && activeGameContext.consoleId === consoleDef.id
                ? `Jogo: ${activeGameContext.gameName}`
                : 'Por Jogo (nenhum ativo)'}
            </button>
          </div>
        </div>
      </div>

      {/* Input Mode Tabs */}
      <div className="flex flex-wrap items-center gap-2 p-1.5 rounded-xl bg-[#141821] border border-white/10 w-fit">
        <button
          type="button"
          onClick={() => {
            setActiveTab('keyboard');
            setCapturingAction(null);
            setCollisionAlert(null);
          }}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
            activeTab === 'keyboard'
              ? 'bg-orange-500 text-white'
              : 'text-slate-300 hover:text-white hover:bg-white/5'
          }`}
        >
          <Keyboard className="w-4 h-4" />
          Teclado (PC)
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('gamepad');
            setCapturingAction(null);
            setCollisionAlert(null);
          }}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
            activeTab === 'gamepad'
              ? 'bg-orange-500 text-white'
              : 'text-slate-300 hover:text-white hover:bg-white/5'
          }`}
        >
          <Gamepad2 className="w-4 h-4" />
          Controle Bluetooth / USB
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('touch');
            setCapturingAction(null);
            setCollisionAlert(null);
          }}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
            activeTab === 'touch'
              ? 'bg-orange-500 text-white'
              : 'text-slate-300 hover:text-white hover:bg-white/5'
          }`}
        >
          <Smartphone className="w-4 h-4" />
          Touch (Celular / Tablet)
        </button>
      </div>

      {/* Feedback & Collision Warning Banner */}
      {savedToast && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-sm">
          <Check className="w-4 h-4 shrink-0" />
          <span>{savedToast}</span>
        </div>
      )}

      {collisionAlert && (
        <div className="p-4 rounded-xl border border-amber-500/40 bg-amber-500/10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-amber-100">
                Conflito de mapeamento detectado
              </div>
              <p className="text-xs text-amber-200/90 mt-1">
                O comando <span className="font-mono-tabular font-semibold">{collisionAlert.label}</span> já está
                atribuído à ação <span className="font-semibold">"{getActionLabel(collisionAlert.conflictAction)}"</span>.
                Nenhuma ação pode ficar sem binding ou duplicada sem confirmação.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setCollisionAlert(null)}
              className="px-3 py-1.5 rounded-lg border border-white/15 text-xs font-medium text-slate-200 hover:bg-white/10"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleConfirmSwapCollision}
              className="px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-semibold"
            >
              Trocar entre ações
            </button>
          </div>
        </div>
      )}

      {/* TAB 1: KEYBOARD */}
      {activeTab === 'keyboard' && (
        <div className="rounded-xl border border-white/10 bg-[#141821] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-white/10 flex items-center justify-between">
            <span className="text-sm font-medium text-white">
              Mapeamento de Teclado — {consoleDef.name}
            </span>
            <span className="text-xs text-slate-400">
              Clique em uma tecla para reatribuir (Esc cancela)
            </span>
          </div>

          <div className="divide-y divide-white/[0.06]">
            {consoleDef.actions.map((action) => {
              const isCapturing = capturingAction === action;
              const code = profile.keyboard[action];
              return (
                <div
                  key={action}
                  className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-white/[0.02]"
                >
                  <div>
                    <div className="text-sm font-medium text-slate-100">
                      {getActionLabel(action)}
                    </div>
                    <div className="text-xs text-slate-500 font-mono-tabular">
                      Ação: {action.toUpperCase()}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setCollisionAlert(null);
                      setCapturingAction(isCapturing ? null : action);
                    }}
                    className={`min-w-[160px] px-3.5 py-2 rounded-lg border font-mono-tabular text-xs font-medium transition-colors text-center ${
                      isCapturing
                        ? 'border-orange-400 bg-orange-500/20 text-orange-200'
                        : 'border-white/15 bg-[#0B0D12] text-slate-200 hover:border-orange-500/60'
                    }`}
                  >
                    {isCapturing ? 'Pressione uma tecla...' : formatKeyCode(code)}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: GAMEPAD (BLUETOOTH / USB) */}
      {activeTab === 'gamepad' && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl border border-white/10 bg-[#141821] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Gamepad2
                className={`w-5 h-5 ${gamepads.length > 0 ? 'text-emerald-400' : 'text-slate-500'}`}
              />
              <div>
                <div className="text-sm font-medium text-white">
                  {gamepads.length > 0
                    ? `${gamepads.length} controle(s) detectado(s)`
                    : 'Nenhum controle Bluetooth/USB ativo'}
                </div>
                <div className="text-xs text-slate-400">
                  {gamepads.length > 0
                    ? gamepads.map((g) => `${g.id} (${g.buttonsCount} botões)`).join(' · ')
                    : 'Conecte seu controle via Bluetooth ou USB e pressione qualquer botão para ativar a Gamepad API.'}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-[#141821] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-white/10 flex items-center justify-between">
              <span className="text-sm font-medium text-white">
                Botões Físicos — {consoleDef.name}
              </span>
              <span className="text-xs text-slate-400">
                Clique e pressione o botão físico no controle
              </span>
            </div>

            <div className="divide-y divide-white/[0.06]">
              {consoleDef.actions.map((action) => {
                const isCapturing = capturingAction === action;
                const bind = profile.gamepad[action];
                return (
                  <div
                    key={action}
                    className="flex items-center justify-between gap-4 px-5 py-3 hover:bg-white/[0.02]"
                  >
                    <div>
                      <div className="text-sm font-medium text-slate-100">
                        {getActionLabel(action)}
                      </div>
                      <div className="text-xs text-slate-500 font-mono-tabular">
                        Ação: {action.toUpperCase()}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setCollisionAlert(null);
                        setCapturingAction(isCapturing ? null : action);
                      }}
                      className={`min-w-[190px] px-3.5 py-2 rounded-lg border font-mono-tabular text-xs font-medium transition-colors text-center ${
                        isCapturing
                          ? 'border-orange-400 bg-orange-500/20 text-orange-200'
                          : 'border-white/15 bg-[#0B0D12] text-slate-200 hover:border-orange-500/60'
                      }`}
                    >
                      {isCapturing ? 'Aguardando botão...' : formatGamepadBinding(bind)}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: TOUCH + DRAG-AND-DROP LAYOUT EDITOR */}
      {activeTab === 'touch' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* Interactive Drag-and-Drop Stage */}
          <div className="xl:col-span-2 rounded-xl border border-white/10 bg-[#141821] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Move className="w-4 h-4 text-orange-400" />
                <span className="text-sm font-semibold text-white">
                  Editor de Layout Touch (Arraste os controles)
                </span>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center p-0.5 rounded-lg bg-[#0B0D12] border border-white/10 text-xs">
                  <button
                    type="button"
                    onClick={() => setPreviewOrientation('landscape')}
                    className={`px-2.5 py-1 rounded-md font-medium ${
                      previewOrientation === 'landscape'
                        ? 'bg-orange-500 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Paisagem
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewOrientation('portrait')}
                    className={`px-2.5 py-1 rounded-md font-medium ${
                      previewOrientation === 'portrait'
                        ? 'bg-orange-500 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Retrato
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const resetTouch = createDefaultTouchLayout(consoleDef);
                    persistProfile({ ...profile, touch: resetTouch }, 'Layout touch restaurado.');
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 text-xs text-slate-300 hover:bg-white/5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Padrão
                </button>
              </div>
            </div>

            {centerWarn && (
              <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                Área central protegida: os botões são mantidos nas laterais/bordas para não cobrir o jogo.
              </div>
            )}

            <div className="flex justify-center bg-[#090B0F] rounded-xl border border-white/10 p-3">
              <div
                className={`relative rounded-lg border border-white/15 bg-gradient-to-b from-slate-900 to-[#0B0D12] overflow-hidden ${
                  previewOrientation === 'landscape'
                    ? 'w-full aspect-video max-h-[430px]'
                    : 'w-[300px] h-[520px]'
                }`}
              >
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-center px-4">
                    <div className="text-xs font-mono-tabular text-slate-500">
                      TELA DO JOGO ({consoleDef.shortName})
                    </div>
                    <div className="text-[11px] text-slate-600 mt-1">
                      Arraste D-Pad e botões para ajustar posições
                    </div>
                  </div>
                </div>

                <TouchControlsOverlay
                  layout={profile.touch}
                  opacity={profile.touchOpacity}
                  editMode={true}
                  avoidCenterZone={previewOrientation === 'landscape'}
                  selectedId={selectedTouchId}
                  onSelectButton={setSelectedTouchId}
                  onCenterZoneWarning={setCenterWarn}
                  onLayoutChange={(nextTouch) => {
                    persistProfile({ ...profile, touch: nextTouch });
                  }}
                />
              </div>
            </div>
          </div>

          {/* Right Panel: Selected Button Properties & Action Remap */}
          <div className="rounded-xl border border-white/10 bg-[#141821] p-4 space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-white">Propriedades Touch</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Ajuste transparência, tamanho e qual ação cada botão virtual executa.
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-slate-300">Opacidade dos botões</span>
                <span className="font-mono-tabular text-slate-400">
                  {Math.round(profile.touchOpacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.35}
                max={1}
                step={0.05}
                value={profile.touchOpacity}
                onChange={(e) =>
                  persistProfile({ ...profile, touchOpacity: Number(e.target.value) })
                }
                className="w-full accent-orange-500"
              />
            </div>

            {selectedTouchButton && (
              <div className="pt-4 border-t border-white/10 space-y-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-orange-300">
                    Selecionado: {selectedTouchButton.label}
                  </span>
                  <span className="text-[11px] font-mono-tabular text-slate-400">
                    X {selectedTouchButton.xPct}% · Y {selectedTouchButton.yPct}%
                  </span>
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-slate-300">Tamanho (px)</span>
                    <span className="font-mono-tabular text-slate-400">
                      {selectedTouchButton.sizePx}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min={selectedTouchButton.action === 'dpad' ? 96 : 42}
                    max={selectedTouchButton.action === 'dpad' ? 168 : 76}
                    step={2}
                    value={selectedTouchButton.sizePx}
                    onChange={(e) => {
                      const sizePx = Number(e.target.value);
                      persistProfile({
                        ...profile,
                        touch: profile.touch.map((t) =>
                          t.id === selectedTouchButton.id ? { ...t, sizePx } : t
                        ),
                      });
                    }}
                    className="w-full accent-orange-500"
                  />
                </div>

                {selectedTouchButton.action !== 'dpad' && (
                  <div>
                    <label className="block text-xs text-slate-300 mb-1.5">
                      Ação atribuída ao botão
                    </label>
                    <select
                      value={selectedTouchButton.action}
                      onChange={(e) =>
                        handleTouchActionReassign(
                          selectedTouchButton.id,
                          e.target.value as ActionId
                        )
                      }
                      className="w-full px-3 py-2 rounded-lg bg-[#0B0D12] border border-white/10 text-xs text-white focus:outline-none focus:border-orange-500"
                    >
                      {consoleDef.actions
                        .filter((a) => !['up', 'down', 'left', 'right'].includes(a))
                        .map((act) => (
                          <option key={act} value={act}>
                            {getActionLabel(act)}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            <div className="pt-4 border-t border-white/10">
              <div className="text-xs font-medium text-slate-300 mb-2">Botões no layout</div>
              <div className="flex flex-wrap gap-1.5">
                {profile.touch.map((btn) => (
                  <button
                    key={btn.id}
                    type="button"
                    onClick={() => setSelectedTouchId(btn.id)}
                    className={`px-2.5 py-1 rounded text-xs font-mono-tabular border transition-colors ${
                      selectedTouchId === btn.id
                        ? 'border-orange-500 bg-orange-500/20 text-white'
                        : 'border-white/10 bg-[#0B0D12] text-slate-400 hover:text-white'
                    }`}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
