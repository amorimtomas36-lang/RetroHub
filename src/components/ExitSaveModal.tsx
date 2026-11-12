import React, { useState } from 'react';
import { HardDrive, LogOut, Save, X } from 'lucide-react';
import { SaveStateRecord } from '../utils/indexedDb';
import { formatBytes } from '../utils/romDetector';

interface ExitSaveModalProps {
  open: boolean;
  gameName: string;
  consoleName: string;
  slots: (SaveStateRecord | null)[];
  saving: boolean;
  canSave?: boolean;
  saveError?: string | null;
  onSaveAndExit: (slot: number) => Promise<void>;
  onExitWithoutSaving: () => void;
  onCancel: () => void;
}

export const ExitSaveModal: React.FC<ExitSaveModalProps> = ({
  open,
  gameName,
  consoleName,
  slots,
  saving,
  canSave = true,
  saveError = null,
  onSaveAndExit,
  onExitWithoutSaving,
  onCancel,
}) => {
  const [selectedSlot, setSelectedSlot] = useState<number>(1);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="exit-modal-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-[#141821] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div>
            <h2 id="exit-modal-title" className="text-lg font-semibold text-white">
              Sair do jogo
            </h2>
            <p className="text-xs text-slate-400 mt-0.5 truncate max-w-sm">
              {gameName} · {consoleName}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Voltar ao jogo"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-300 leading-relaxed">
            Deseja salvar seu progresso atual no navegador (IndexedDB) antes de sair? Escolha um dos 5 slots abaixo:
          </p>

          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((slotNum) => {
              const existing = slots[slotNum - 1];
              const isSelected = selectedSlot === slotNum;
              return (
                <button
                  key={slotNum}
                  type="button"
                  onClick={() => setSelectedSlot(slotNum)}
                  disabled={saving}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg border text-left transition-colors ${
                    isSelected
                      ? 'border-orange-500 bg-orange-500/12 text-white'
                      : 'border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-7 h-7 rounded-md flex items-center justify-center font-mono-tabular text-xs font-semibold shrink-0 ${
                        isSelected ? 'bg-orange-500 text-white' : 'bg-white/10 text-slate-300'
                      }`}
                    >
                      {slotNum}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-medium">
                        Slot {slotNum}{' '}
                        {existing ? (
                          <span className="text-xs text-amber-400 font-normal">· Sobrescrever</span>
                        ) : (
                          <span className="text-xs text-slate-500 font-normal">· Vazio</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 font-mono-tabular truncate">
                        {existing
                          ? `${new Date(existing.updatedAt).toLocaleString('pt-BR')} · ${formatBytes(
                              existing.sizeBytes
                            )}`
                          : 'Nenhum estado salvo neste slot'}
                      </div>
                    </div>
                  </div>
                  <HardDrive className={`w-4 h-4 shrink-0 ${isSelected ? 'text-orange-400' : 'text-slate-500'}`} />
                </button>
              );
            })}
          </div>

          {!canSave && (
            <div className="px-3.5 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs text-amber-200">
              O núcleo do emulador ainda não terminou de carregar. Aguarde iniciar para salvar ou clique em "Sair sem salvar".
            </div>
          )}

          {saveError && (
            <div className="px-3.5 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-200">
              {saveError}
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2.5 px-5 py-4 border-t border-white/10 bg-[#0F1219]">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 transition-colors whitespace-nowrap"
          >
            Continuar jogando
          </button>
          <button
            type="button"
            onClick={onExitWithoutSaving}
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/15 transition-colors whitespace-nowrap"
          >
            <LogOut className="w-4 h-4" />
            Sair sem salvar
          </button>
          <button
            type="button"
            onClick={() => onSaveAndExit(selectedSlot)}
            disabled={saving || !canSave}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg bg-orange-500 hover:bg-orange-600 text-white transition-colors whitespace-nowrap disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Salvando...' : `Salvar no Slot ${selectedSlot} e sair`}
          </button>
        </div>
      </div>
    </div>
  );
};
