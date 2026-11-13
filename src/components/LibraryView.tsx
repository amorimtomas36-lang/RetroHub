import React, { useMemo, useState } from 'react';
import {
  Cloud,
  FileUp,
  FolderOpen,
  HardDrive,
  Play,
  Search,
  Trash2,
} from 'lucide-react';
import { ConsoleDefinition, getConsoleById } from '../data/consoles';
import {
  LibraryGameItem,
  StorageStatus,
  downloadSavedLibraryRom,
  removeGameFromLibrary,
} from '../utils/api';
import { formatBytes } from '../utils/romDetector';

interface LibraryViewProps {
  games: LibraryGameItem[];
  loading: boolean;
  storageStatus: StorageStatus | null;
  onPlaySavedGame: (file: File, consoleDef: ConsoleDefinition, gameId: string) => void;
  onRefreshLibrary: () => Promise<void>;
  onGoToUpload: () => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  games,
  loading,
  storageStatus,
  onPlaySavedGame,
  onRefreshLibrary,
  onGoToUpload,
}) => {
  const [search, setSearch] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return games;
    return games.filter(
      (g) =>
        g.gameName.toLowerCase().includes(q) ||
        g.consoleName.toLowerCase().includes(q) ||
        g.fileName.toLowerCase().includes(q)
    );
  }, [games, search]);

  const handleOpen = async (item: LibraryGameItem) => {
    const consoleDef = getConsoleById(item.consoleId);
    if (!consoleDef) {
      setErrorMsg(`Console "${item.consoleName}" não encontrado.`);
      return;
    }
    setErrorMsg(null);
    setOpeningId(item.gameId);
    try {
      const file = await downloadSavedLibraryRom(item);
      onPlaySavedGame(file, consoleDef, item.gameId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao abrir jogo salvo.');
    } finally {
      setOpeningId(null);
    }
  };

  const handleDelete = async (item: LibraryGameItem) => {
    setErrorMsg(null);
    try {
      await removeGameFromLibrary(item.gameId);
      await onRefreshLibrary();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao remover jogo.');
    }
  };

  const cloudReady = storageStatus?.configured === true;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
            Minha Biblioteca Salva
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Os jogos que adicionares à tua conta ficam guardados na biblioteca RetroHub, com ficheiros na nuvem privada.
          </p>
        </div>

        <button
          type="button"
          onClick={onGoToUpload}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold transition-colors whitespace-nowrap"
        >
          <FileUp className="w-4 h-4" />
          Adicionar Novo Jogo
        </button>
      </div>

      <div className="rounded-xl border border-white/10 bg-[#141821] p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          <div className="w-10 h-10 rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-400 flex items-center justify-center shrink-0">
            <Cloud className="w-5 h-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-semibold text-white flex flex-wrap items-center gap-2">
              <span>Armazenamento na Nuvem RetroHub</span>
              <span className={`text-xs font-normal ${cloudReady ? 'text-emerald-400' : 'text-amber-300'}`}>
                {cloudReady ? 'Ligado' : 'A verificar configuração'}
              </span>
            </div>
            <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
              Os novos jogos são guardados no armazenamento privado da RetroHub. A base de dados guarda as contas e a biblioteca; os ficheiros ficam separados na nuvem.
            </p>
            <div className="text-[11px] text-slate-500">
              {storageStatus?.database || 'Base de dados'} · {storageStatus?.files || 'Armazenamento de ficheiros'}
            </div>
          </div>
        </div>
        <div className="text-xs text-slate-400">{games.length} jogo(s) na biblioteca</div>
      </div>

      {games.length > 0 && (
        <div className="relative max-w-md">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar jogo salvo ou console..."
            className="w-full pl-10 pr-4 py-2 rounded-lg bg-[#141821] border border-white/10 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-orange-500"
          />
        </div>
      )}

      {errorMsg && (
        <div className="px-4 py-3 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-200">
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-white/10 bg-[#141821] p-10 text-center text-sm text-slate-400">
          Carregando jogos salvos da sua conta...
        </div>
      ) : games.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/15 bg-[#141821] p-12 text-center space-y-3">
          <FolderOpen className="w-9 h-9 text-slate-500 mx-auto" />
          <div className="text-base font-semibold text-white">
            Sua biblioteca ainda está vazia
          </div>
          <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
            Quando você enviar uma ROM em "Carregar Jogo" ou na página de qualquer console, ela ficará salva aqui na sua nuvem automaticamente.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={onGoToUpload}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold transition-colors"
            >
              <FileUp className="w-4 h-4" />
              Enviar Primeiro Jogo
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-[#141821] p-8 text-center text-sm text-slate-400">
          Nenhum jogo encontrado para "{search}".
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => {
            const isOpening = openingId === item.gameId;
            const isCloud = item.storageProvider === 'neon' || item.storageProvider === 'terabox';
            const storageLabel = item.storageProvider === 'neon' ? 'Nuvem RetroHub' : item.storageProvider === 'terabox' ? 'Nuvem TeraBox (legado)' : 'Conta local';
            return (
              <div
                key={item.id}
                className="rounded-xl border border-white/10 bg-[#141821] p-4 flex flex-col justify-between gap-4 hover:border-orange-500/40 transition-colors"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                    <span className="text-orange-400 font-medium truncate">
                      {item.consoleName}
                    </span>
                    <span className="font-mono-tabular shrink-0">
                      {formatBytes(item.fileSize)}
                    </span>
                  </div>
                  <h2 className="text-base font-semibold text-white truncate" title={item.gameName}>
                    {item.gameName}
                  </h2>
                  <div className="text-[11px] text-slate-500 font-mono-tabular truncate">
                    {item.fileName}
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="text-slate-500 font-mono-tabular truncate">
                      {new Date(item.lastPlayedAt).toLocaleDateString('pt-BR')}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 shrink-0 ${
                        isCloud ? 'text-sky-400' : 'text-slate-400'
                      }`}
                    >
                      {isCloud ? (
                        <>
                          <Cloud className="w-3 h-3" />
                          {storageLabel}
                        </>
                      ) : (
                        <>
                          <HardDrive className="w-3 h-3" />
                          {storageLabel}
                        </>
                      )}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-2 border-t border-white/[0.06]">
                  <button
                    type="button"
                    disabled={isOpening}
                    onClick={() => handleOpen(item)}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-xs font-semibold transition-colors"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    {isOpening ? 'Baixando da nuvem...' : 'Jogar'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(item)}
                    className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-red-400 hover:border-red-500/30 transition-colors"
                    title="Remover da biblioteca salva"
                    aria-label={`Remover ${item.gameName}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
