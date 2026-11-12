import React, { useEffect, useRef, useState } from 'react';
import { Download, HardDrive, Trash2, Upload } from 'lucide-react';
import {
  SaveStateRecord,
  deleteSaveStateSlot,
  exportSaveStateFile,
  getAllSaveStates,
  parseImportedSaveFile,
  saveGameStateSlot,
} from '../utils/indexedDb';
import { formatBytes } from '../utils/romDetector';

export const SaveManagerView: React.FC = () => {
  const [saves, setSaves] = useState<SaveStateRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await getAllSaveStates();
      setSaves(list);
    } catch {
      setSaves([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const groupedByGame = saves.reduce<Record<string, SaveStateRecord[]>>((acc, item) => {
    if (!acc[item.gameId]) acc[item.gameId] = [];
    acc[item.gameId].push(item);
    return acc;
  }, {});

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = await parseImportedSaveFile(file, {
        gameId: '',
        gameName: '',
        consoleId: '',
        consoleName: '',
        slot: 0,
      });
      await saveGameStateSlot(parsed);
      await refresh();
      setFeedback(`Save "${parsed.gameName}" (Slot ${parsed.slot}) importado para o IndexedDB.`);
      setTimeout(() => setFeedback(null), 3500);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Falha ao importar arquivo .rhsave.');
      setTimeout(() => setFeedback(null), 4000);
    }
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Meus Save States
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Todos os saves ficam armazenados localmente no IndexedDB do seu navegador (até 5 slots por jogo). Exporte para fazer backup ou transfira para outro dispositivo.
          </p>
        </div>

        <div>
          <input
            ref={importInputRef}
            type="file"
            accept=".rhsave,.json"
            onChange={handleImportFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold transition-colors whitespace-nowrap"
          >
            <Upload className="w-4 h-4" />
            Importar Save (.rhsave)
          </button>
        </div>
      </div>

      {feedback && (
        <div className="px-4 py-2.5 rounded-lg border border-orange-500/30 bg-orange-500/10 text-xs text-orange-100">
          {feedback}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-white/10 bg-[#141821] p-8 text-center text-sm text-slate-400">
          Carregando saves do IndexedDB...
        </div>
      ) : Object.keys(groupedByGame).length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 bg-[#141821] p-12 text-center space-y-2">
          <HardDrive className="w-8 h-8 text-slate-500 mx-auto" />
          <div className="text-base font-medium text-white">Nenhum save state salvo ainda</div>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Carregue uma ROM na aba "Carregar Jogo" e use os 5 slots de save durante a partida ou ao sair do jogo.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(groupedByGame).map(([gameId, gameSaves]) => {
            const first = gameSaves[0];
            return (
              <div
                key={gameId}
                className="rounded-xl border border-white/10 bg-[#141821] overflow-hidden"
              >
                <div className="px-5 py-3.5 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-white">{first.gameName}</h2>
                    <div className="text-xs text-slate-400">
                      {first.consoleName} · ID{' '}
                      <span className="font-mono-tabular text-slate-300">{gameId}</span>
                    </div>
                  </div>
                  <div className="text-xs font-mono-tabular text-slate-400">
                    {gameSaves.length} / 5 slots ocupados
                  </div>
                </div>

                <div className="divide-y divide-white/[0.06]">
                  {gameSaves
                    .slice()
                    .sort((a, b) => a.slot - b.slot)
                    .map((rec) => (
                      <div
                        key={rec.id}
                        className="flex flex-wrap items-center justify-between gap-4 px-5 py-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {rec.screenshotDataUrl ? (
                            <img
                              src={rec.screenshotDataUrl}
                              alt={`Slot ${rec.slot}`}
                              className="w-16 h-11 object-cover rounded border border-white/10 shrink-0"
                            />
                          ) : (
                            <div className="w-16 h-11 rounded bg-[#0B0D12] border border-white/10 flex items-center justify-center text-xs font-mono-tabular text-slate-500 shrink-0">
                              S{rec.slot}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-100">
                              Slot {rec.slot}
                            </div>
                            <div className="text-xs text-slate-400 font-mono-tabular">
                              {new Date(rec.updatedAt).toLocaleString('pt-BR')} ·{' '}
                              {formatBytes(rec.sizeBytes)}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => exportSaveStateFile(rec)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-slate-200 hover:bg-white/5 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Exportar
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              await deleteSaveStateSlot(rec.gameId, rec.slot);
                              refresh();
                            }}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/20 text-xs font-medium text-red-300 hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Excluir
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
