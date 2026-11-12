import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileUp,
  HardDrive,
  Info,
  MousePointer2,
  Settings,
  Zap,
} from 'lucide-react';
import { ConsoleDefinition } from '../data/consoles';
import {
  SaveStateRecord,
  deleteSaveStateSlot,
  exportSaveStateFile,
  getAllSaveStates,
  loadControlProfileSync,
} from '../utils/indexedDb';
import { formatKeyCode } from '../utils/controls';
import { detectRomConsole, formatBytes } from '../utils/romDetector';

interface ConsolePageProps {
  consoleDef: ConsoleDefinition;
  onLaunchRom: (file: File, consoleDef: ConsoleDefinition, gameId: string) => void;
  onOpenControls: (consoleId: string) => void;
}

export const ConsolePage: React.FC<ConsolePageProps> = ({
  consoleDef,
  onLaunchRom,
  onOpenControls,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [mismatchWarning, setMismatchWarning] = useState<{
    file: File;
    gameId: string;
    detectedConsole: ConsoleDefinition;
    reason: string;
  } | null>(null);
  const [unrecognizedMsg, setUnrecognizedMsg] = useState<string | null>(null);
  const [consoleSaves, setConsoleSaves] = useState<SaveStateRecord[]>([]);

  const profile = loadControlProfileSync(consoleDef);

  const loadConsoleData = async () => {
    try {
      const all = await getAllSaveStates();
      setConsoleSaves(all.filter((s) => s.consoleId === consoleDef.id));
    } catch {
      setConsoleSaves([]);
    }
  };

  useEffect(() => {
    let active = true;
    setMismatchWarning(null);
    setUnrecognizedMsg(null);
    getAllSaveStates()
      .then((all) => {
        if (active) setConsoleSaves(all.filter((s) => s.consoleId === consoleDef.id));
      })
      .catch(() => {
        if (active) setConsoleSaves([]);
      });
    return () => {
      active = false;
    };
  }, [consoleDef.id]);

  const handleFile = async (file: File) => {
    setMismatchWarning(null);
    setUnrecognizedMsg(null);
    try {
      const res = await detectRomConsole(file, consoleDef.id);

      if (res.status === 'unrecognized') {
        setUnrecognizedMsg(
          `${res.message} Extensões esperadas para ${consoleDef.name}: ${consoleDef.extensions.join(', ')}.`
        );
        return;
      }

      if (res.console && res.console.id !== consoleDef.id) {
        setMismatchWarning({
          file,
          gameId: res.gameId,
          detectedConsole: res.console,
          reason: res.message,
        });
        return;
      }

      onLaunchRom(file, consoleDef, res.gameId);
    } catch {
      setUnrecognizedMsg(
        'Não foi possível ler este arquivo. Verifique se você selecionou um arquivo de ROM válido (e não uma pasta).'
      );
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Console Header */}
      <div className="rounded-2xl border border-white/10 bg-[#141821] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>{consoleDef.manufacturer}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular">{consoleDef.year}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono-tabular text-orange-400">
                Núcleo {consoleDef.ejsCore}
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-emerald-400 inline-flex items-center gap-1 font-medium">
                <Zap className="w-3.5 h-3.5" />
                Inicialização Automática
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
              {consoleDef.name}
            </h1>
            <p className="text-sm text-slate-300 max-w-2xl leading-relaxed pt-1">
              {consoleDef.description}
            </p>
          </div>

          <button
            type="button"
            onClick={() => onOpenControls(consoleDef.id)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/10 text-sm font-medium text-slate-200 hover:text-white hover:bg-white/5 transition-colors whitespace-nowrap"
          >
            <Settings className="w-4 h-4 text-orange-400" />
            Configurar Controles
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-5 mt-5 border-t border-white/10 text-xs">
          <div>
            <span className="text-slate-500 block mb-0.5">Extensões suportadas</span>
            <span className="font-mono-tabular text-slate-200">
              {consoleDef.extensions.join(', ')}
            </span>
          </div>
          <div>
            <span className="text-slate-500 block mb-0.5">Proporção de tela</span>
            <span className="font-mono-tabular text-slate-200">{consoleDef.aspectRatio}</span>
          </div>
          <div>
            <span className="text-slate-500 block mb-0.5">Mouse / Light Gun</span>
            <span className="text-slate-200 inline-flex items-center gap-1.5">
              {consoleDef.supportsMouse ? (
                <>
                  <MousePointer2 className="w-3.5 h-3.5 text-sky-400" />
                  Suportado
                </>
              ) : (
                'Gamepad / Teclado / Touch'
              )}
            </span>
          </div>
        </div>

        {consoleDef.mouseNote && (
          <div className="mt-4 pt-4 border-t border-white/10 text-xs text-slate-300 flex items-start gap-2">
            <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            <span>{consoleDef.mouseNote}</span>
          </div>
        )}
      </div>

      {/* Console-Specific ROM Uploader */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-orange-500 bg-orange-500/10'
            : 'border-white/15 bg-[#141821] hover:border-orange-500/50'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
        <FileUp className="w-8 h-8 text-orange-400 mx-auto mb-3" />
        <div className="text-sm font-semibold text-white">
          Carregar ROM de {consoleDef.name} (Abertura e Salvamento Automáticos)
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Arraste seu arquivo ({consoleDef.extensions.join(', ')}) ou clique para salvar na conta e iniciar direto
        </p>
      </div>

      {unrecognizedMsg && (
        <div className="p-4 rounded-xl border border-red-500/35 bg-red-500/10 text-sm text-red-200 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Arquivo não reconhecido</div>
            <p className="text-xs mt-1 text-red-200/90">{unrecognizedMsg}</p>
          </div>
        </div>
      )}

      {mismatchWarning && (
        <div className="p-4 rounded-xl border border-amber-500/35 bg-amber-500/10 space-y-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-amber-100">
                Esta ROM parece ser de {mismatchWarning.detectedConsole.name}
              </div>
              <p className="text-xs text-amber-200/90 mt-1">{mismatchWarning.reason}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pl-8">
            <button
              type="button"
              onClick={() =>
                onLaunchRom(
                  mismatchWarning.file,
                  mismatchWarning.detectedConsole,
                  mismatchWarning.gameId
                )
              }
              className="px-3.5 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold"
            >
              Abrir no núcleo {mismatchWarning.detectedConsole.name}
            </button>
            <button
              type="button"
              onClick={() =>
                onLaunchRom(mismatchWarning.file, consoleDef, mismatchWarning.gameId)
              }
              className="px-3.5 py-1.5 rounded-lg border border-white/15 text-xs text-slate-200 hover:bg-white/10"
            >
              Forçar em {consoleDef.name}
            </button>
          </div>
        </div>
      )}

      {/* Control summary + Console saves */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="rounded-xl border border-white/10 bg-[#141821] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Controles Atuais (Teclado)</h2>
            <button
              type="button"
              onClick={() => onOpenControls(consoleDef.id)}
              className="text-xs text-orange-400 hover:text-orange-300 font-medium"
            >
              Editar mapeamento
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {consoleDef.actions.map((act) => (
              <div
                key={act}
                className="flex items-center justify-between px-3 py-1.5 rounded bg-[#0B0D12] border border-white/[0.06]"
              >
                <span className="text-slate-400 uppercase font-mono-tabular">{act}</span>
                <span className="text-slate-100 font-mono-tabular font-medium">
                  {formatKeyCode(profile.keyboard[act])}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-[#141821] p-5 space-y-3">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-orange-400" />
            <h2 className="text-sm font-semibold text-white">
              Save States salvos em {consoleDef.shortName}
            </h2>
          </div>

          {consoleSaves.length === 0 ? (
            <p className="text-xs text-slate-400 py-6 text-center border border-dashed border-white/10 rounded-lg">
              Nenhum save state gravado para este console ainda. Carregue uma ROM e salve em qualquer um dos 5 slots.
            </p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {consoleSaves.map((save) => (
                <div
                  key={save.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-[#0B0D12] border border-white/[0.06] text-xs"
                >
                  <div className="min-w-0">
                    <div className="text-slate-100 font-medium truncate">
                      {save.gameName} · Slot {save.slot}
                    </div>
                    <div className="text-slate-500 font-mono-tabular">
                      {new Date(save.updatedAt).toLocaleString('pt-BR')} · {formatBytes(save.sizeBytes)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => exportSaveStateFile(save)}
                      className="text-orange-400 hover:text-orange-300 font-medium"
                    >
                      Exportar
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteSaveStateSlot(save.gameId, save.slot);
                        loadConsoleData();
                      }}
                      className="text-slate-500 hover:text-red-400"
                    >
                      Apagar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
