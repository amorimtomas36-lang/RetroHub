import React, { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileUp, Play, ShieldAlert, Zap } from 'lucide-react';
import { CONSOLES, ConsoleDefinition, getConsoleById } from '../data/consoles';
import { RomDetectionResult, detectRomConsole, formatBytes } from '../utils/romDetector';

interface RomLoaderViewProps {
  onLaunchRom: (file: File, consoleDef: ConsoleDefinition, gameId: string) => void;
}

export const RomLoaderView: React.FC<RomLoaderViewProps> = ({ onLaunchRom }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [detection, setDetection] = useState<RomDetectionResult | null>(null);
  const [manualConsoleId, setManualConsoleId] = useState<string>('');

  const [readError, setReadError] = useState<string | null>(null);

  const processFile = async (file: File) => {
    setAnalyzing(true);
    setReadError(null);
    setSelectedFile(file);
    try {
      const result = await detectRomConsole(file);
      setDetection(result);
      if (result.console) {
        setManualConsoleId(result.console.id);
        if (autoLaunch && result.status === 'detected') {
          onLaunchRom(file, result.console, result.gameId);
          return;
        }
      } else if (result.candidates.length > 0) {
        setManualConsoleId(result.candidates[0].id);
      } else {
        setManualConsoleId('');
      }
    } catch {
      setDetection(null);
      setReadError('Não foi possível ler este item. Selecione um arquivo de ROM válido (e não uma pasta).');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleLaunch = () => {
    if (!selectedFile || !detection) return;
    const chosen = getConsoleById(manualConsoleId) ?? detection.console;
    if (!chosen) return;
    onLaunchRom(selectedFile, chosen, detection.gameId);
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Carregar Jogo
          </h1>
          <p className="text-sm text-slate-400 mt-1.5 leading-relaxed">
            Envie uma ROM do seu dispositivo. A detecção de console, salvamento na sua conta e abertura no emulador acontecem de forma 100% automática.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAutoLaunch((v) => !v)}
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap ${
            autoLaunch
              ? 'border-orange-500/50 bg-orange-500/15 text-orange-200'
              : 'border-white/15 bg-[#141821] text-slate-400 hover:text-white'
          }`}
        >
          <Zap className="w-3.5 h-3.5" />
          Abertura 100% Automática: {autoLaunch ? 'Ativada' : 'Manual'}
        </button>
      </div>

      {/* Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        className={`rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-orange-500 bg-orange-500/10'
            : 'border-white/15 bg-[#141821] hover:border-orange-500/50 hover:bg-[#171C27]'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) processFile(f);
            e.target.value = '';
          }}
        />
        <div className="w-12 h-12 rounded-xl bg-orange-500/15 border border-orange-500/30 text-orange-400 flex items-center justify-center mx-auto mb-4">
          <FileUp className="w-6 h-6" />
        </div>
        <div className="text-base font-semibold text-white">
          {analyzing
            ? 'Detectando console e preparando emulador...'
            : 'Arraste sua ROM aqui ou clique para iniciar automaticamente'}
        </div>
        <p className="text-xs text-slate-400 mt-2 max-w-xl mx-auto">
          Suporta os formatos compatíveis com os {CONSOLES.length} sistemas ativos, incluindo .nes, .sfc, .gba, .nds, .iso, .cue, .zip, .wad, .dsk, .adf e outros.
        </p>
      </div>

      {readError && (
        <div className="p-4 rounded-xl border border-red-500/35 bg-red-500/10 text-xs text-red-200 flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{readError}</span>
        </div>
      )}

      {/* Detection Result (shown when manual mode or ambiguous/unrecognized) */}
      {detection && selectedFile && (
        <div className="rounded-xl border border-white/10 bg-[#141821] p-5 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              {detection.status === 'detected' ? (
                <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0 mt-0.5" />
              ) : detection.status === 'ambiguous' ? (
                <AlertCircle className="w-6 h-6 text-amber-400 shrink-0 mt-0.5" />
              ) : (
                <ShieldAlert className="w-6 h-6 text-red-400 shrink-0 mt-0.5" />
              )}

              <div>
                <h2 className="text-base font-semibold text-white">
                  {detection.status === 'detected'
                    ? `Console detectado: ${detection.console?.name}`
                    : detection.status === 'ambiguous'
                    ? 'Extensão compartilhada — confirme o console'
                    : 'Formato de ROM não reconhecido'}
                </h2>
                <p className="text-sm text-slate-300 mt-1">{detection.message}</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-3 border-t border-white/10 text-xs">
            <div>
              <span className="text-slate-500 block">Arquivo</span>
              <span className="text-slate-200 font-medium truncate block">{detection.fileName}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Tamanho</span>
              <span className="text-slate-200 font-mono-tabular">{formatBytes(detection.fileSize)}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Método</span>
              <span className="text-slate-200">{detection.method}</span>
            </div>
            <div>
              <span className="text-slate-500 block">ID para Saves</span>
              <span className="text-slate-200 font-mono-tabular">{detection.gameId}</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pt-3 border-t border-white/10">
            <div className="flex-1 max-w-md">
              <label htmlFor="manual-console" className="block text-xs font-medium text-slate-400 mb-1.5">
                {detection.status === 'detected'
                  ? 'Console selecionado (altere se necessário)'
                  : 'Selecione o emulador manualmente'}
              </label>
              <select
                id="manual-console"
                value={manualConsoleId}
                onChange={(e) => setManualConsoleId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0B0D12] border border-white/10 text-sm text-white focus:outline-none focus:border-orange-500"
              >
                <option value="">-- Escolha um dos {CONSOLES.length} emuladores --</option>
                {CONSOLES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.extensions.join(', ')})
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              disabled={!manualConsoleId}
              onClick={handleLaunch}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white text-sm font-semibold transition-colors whitespace-nowrap"
            >
              <Play className="w-4 h-4 fill-current" />
              Abrir no Emulador
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-[#11141C] p-4 text-xs text-slate-400 leading-relaxed">
        <strong className="text-slate-200 font-semibold">Aviso legal:</strong> O RetroHub não hospeda nem distribui ROMs públicas. Os arquivos que você envia ficam salvos exclusivamente na sua conta pessoal para abrir automaticamente quando quiser.
      </div>
    </div>
  );
};
