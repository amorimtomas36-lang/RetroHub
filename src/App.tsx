import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cloud,
  BrainCircuit,
  FileUp,
  FolderOpen,
  Gamepad2,
  Gauge,
  HardDrive,
  LogOut,
  Menu,
  Play,
  Search,
  Settings,
  Smartphone,
  User as UserIcon,
  X,
} from 'lucide-react';
import {
  CONSOLE_CATEGORIES,
  CONSOLES,
  ConsoleDefinition,
  getConsoleById,
  getConsoleBySlug,
} from './data/consoles';
import { AuthPage } from './components/AuthPage';
import { AIHubView } from './components/AIHubView';
import { GameOptimizerView } from './components/GameOptimizerView';
import { ConsolePage } from './components/ConsolePage';
import { ControlsConfigView } from './components/ControlsConfigView';
import { ActiveRomSession, EmulatorPlayer } from './components/EmulatorPlayer';
import { LibraryView } from './components/LibraryView';
import { RomLoaderView } from './components/RomLoaderView';
import { SaveManagerView } from './components/SaveManagerView';
import {
  AuthUser,
  LibraryGameItem,
  StorageStatus,
  downloadSavedLibraryRom,
  fetchCurrentUser,
  fetchSavedLibrary,
  fetchStorageStatus,
  logoutAccount,
  saveGameToLibrary,
} from './utils/api';
import { cacheGameRom, setIndexedDbUserScope } from './utils/indexedDb';
import { formatBytes } from './utils/romDetector';

type AppRoute =
  | { view: 'home' }
  | { view: 'library' }
  | { view: 'loader' }
  | { view: 'controls'; consoleId?: string }
  | { view: 'saves' }
  | { view: 'ai' }
  | { view: 'optimizer' }
  | { view: 'console'; slug: string }
  | { view: 'play'; slug: string };

function parsePathToRoute(pathname: string): AppRoute {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '/index.html') return { view: 'home' };
  if (clean === '/biblioteca') return { view: 'library' };
  if (clean === '/carregar-jogo') return { view: 'loader' };
  if (clean === '/controles') return { view: 'controls' };
  if (clean === '/saves') return { view: 'saves' };
  if (clean === '/ia') return { view: 'ai' };
  if (clean === '/otimizar') return { view: 'optimizer' };
  if (clean.startsWith('/console/')) {
    const slug = clean.slice('/console/'.length);
    if (getConsoleBySlug(slug)) return { view: 'console', slug };
  }
  if (clean.startsWith('/jogar/')) {
    const slug = clean.slice('/jogar/'.length);
    if (getConsoleBySlug(slug)) return { view: 'play', slug };
  }
  return { view: 'home' };
}

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [route, setRoute] = useState<AppRoute>(() =>
    parsePathToRoute(typeof window !== 'undefined' ? window.location.pathname : '/')
  );
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSession, setActiveSession] = useState<ActiveRomSession | null>(null);

  const [libraryGames, setLibraryGames] = useState<LibraryGameItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [openingSavedId, setOpeningSavedId] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );
  const noticeTimerRef = useRef<number | null>(null);

  const showLibraryNotice = useCallback(
    (type: 'ok' | 'err', text: string, durationMs = 3500) => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
      setLibraryNotice({ type, text });
      noticeTimerRef.current = window.setTimeout(() => {
        setLibraryNotice(null);
        noticeTimerRef.current = null;
      }, durationMs);
    },
    []
  );

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const refreshLibrary = useCallback(async () => {
    setLibraryLoading(true);
    try {
      const items = await fetchSavedLibrary();
      setLibraryGames(items);
    } catch {
      setLibraryGames([]);
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  const refreshStorage = useCallback(async () => {
    try {
      const status = await fetchStorageStatus();
      setStorageStatus(status);
    } catch {
      setStorageStatus(null);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await fetchCurrentUser();
        if (!active) return;
        if (me) {
          setIndexedDbUserScope(me.id);
          setUser(me);
        } else {
          setIndexedDbUserScope(null);
          setUser(null);
        }
      } catch {
        if (active) {
          setIndexedDbUserScope(null);
          setUser(null);
        }
      } finally {
        if (active) setAuthChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (user) {
      setIndexedDbUserScope(user.id);
      refreshLibrary();
      refreshStorage();
    } else {
      setIndexedDbUserScope(null);
      setLibraryGames([]);
      setStorageStatus(null);
      setActiveSession(null);
    }
  }, [user, refreshLibrary, refreshStorage]);

  const navigate = (path: string, nextRoute?: AppRoute) => {
    if (typeof window !== 'undefined' && window.location.pathname !== path) {
      window.history.pushState({}, '', path);
    }
    setRoute(nextRoute ?? parsePathToRoute(path));
    setMobileMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const onPopState = () => {
      setRoute(parsePathToRoute(window.location.pathname));
    };
    const onUnauthorized = () => {
      setIndexedDbUserScope(null);
      setUser(null);
      setStorageStatus(null);
      setActiveSession(null);
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('retrohub-unauthorized', onUnauthorized);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('retrohub-unauthorized', onUnauthorized);
    };
  }, []);

  // Launches ROM and automatically persists it to the logged-in user's library
  const handleLaunchRom = (
    file: File,
    consoleDef: ConsoleDefinition,
    gameId: string,
    alreadyFromLibrary = false
  ) => {
    const cleanTitle = file.name.replace(/\.[^.]+$/, '') || file.name;
    setActiveSession({
      file,
      gameId,
      gameName: cleanTitle,
      consoleDef,
    });
    navigate(`/jogar/${consoleDef.slug}`, { view: 'play', slug: consoleDef.slug });

    if (!alreadyFromLibrary && user) {
      saveGameToLibrary({
        file,
        gameId,
        gameName: cleanTitle,
        consoleId: consoleDef.id,
        consoleName: consoleDef.name,
      })
        .then((savedGame) => {
          void cacheGameRom(
            savedGame.gameId,
            savedGame.fileName,
            savedGame.fileSize,
            savedGame.addedAt,
            file
          ).catch(() => {});
          refreshLibrary();
          showLibraryNotice(
            'ok',
            savedGame.storageProvider === 'neon'
              ? `"${cleanTitle}" foi guardado na nuvem RetroHub.`
              : savedGame.storageProvider === 'terabox'
                ? `"${cleanTitle}" continua guardado na sua nuvem TeraBox.`
                : `"${cleanTitle}" foi salvo na sua conta.`,
            3500
          );
        })
        .catch((err) => {
          showLibraryNotice(
            'err',
            err instanceof Error
              ? `Jogo aberto, mas não salvo na biblioteca: ${err.message}`
              : 'Jogo aberto, mas não foi possível salvar na biblioteca.',
            4500
          );
        });
    }
  };

  const handleQuickOpenSavedGame = async (item: LibraryGameItem) => {
    const consoleDef = getConsoleById(item.consoleId);
    if (!consoleDef) return;
    setOpeningSavedId(item.gameId);
    try {
      const file = await downloadSavedLibraryRom(item);
      handleLaunchRom(file, consoleDef, item.gameId, true);
      refreshLibrary();
    } catch (err) {
      showLibraryNotice(
        'err',
        err instanceof Error ? err.message : 'Não foi possível abrir o jogo salvo.',
        4000
      );
    } finally {
      setOpeningSavedId(null);
    }
  };

  const handleLogout = async () => {
    await logoutAccount();
    setUser(null);
    setActiveSession(null);
    navigate('/', { view: 'home' });
  };

  const filteredConsolesByCategory = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    return CONSOLE_CATEGORIES.map((cat) => {
      const items = CONSOLES.filter(
        (c) =>
          c.category === cat.id &&
          (!q ||
            c.name.toLowerCase().includes(q) ||
            c.manufacturer.toLowerCase().includes(q) ||
            c.extensions.some((ext) => ext.includes(q)))
      );
      return { ...cat, items };
    }).filter((cat) => cat.items.length > 0);
  }, [sidebarSearch]);

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#0B0D12] text-slate-300 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 rounded-full border-2 border-orange-500 border-t-transparent animate-spin mx-auto" />
          <div className="text-sm">Verificando sessão...</div>
        </div>
      </div>
    );
  }

  // Require login to use the site
  if (!user) {
    return (
      <AuthPage
        onAuthenticated={(loggedUser) => {
          setIndexedDbUserScope(loggedUser.id);
          setUser(loggedUser);
        }}
      />
    );
  }

  const activeConsoleSlug =
    route.view === 'console' || route.view === 'play' ? route.slug : null;

  const renderMainContent = () => {
    if (route.view === 'ai') return <AIHubView username={user.username} />;
    if (route.view === 'optimizer') return <GameOptimizerView games={libraryGames} />;
    if (route.view === 'play') {
      if (activeSession) {
        return (
          <EmulatorPlayer
            key={`${activeSession.gameId}:${activeSession.consoleDef.id}`}
            session={activeSession}
            onExit={() => {
              const targetSlug = activeSession.consoleDef.slug;
              setActiveSession(null);
              navigate(`/console/${targetSlug}`, { view: 'console', slug: targetSlug });
            }}
            onOpenControlsConfig={(consoleId) =>
              navigate('/controles', { view: 'controls', consoleId })
            }
          />
        );
      }
      const fallbackConsole = getConsoleBySlug(route.slug);
      if (fallbackConsole) {
        return (
          <ConsolePage
            consoleDef={fallbackConsole}
            onLaunchRom={handleLaunchRom}
            onOpenControls={(consoleId) =>
              navigate('/controles', { view: 'controls', consoleId })
            }
          />
        );
      }
    }

    if (route.view === 'library') {
      return (
        <LibraryView
          games={libraryGames}
          loading={libraryLoading}
          storageStatus={storageStatus}
          onPlaySavedGame={(file, consoleDef, gameId) =>
            handleLaunchRom(file, consoleDef, gameId, true)
          }
          onRefreshLibrary={refreshLibrary}
          onGoToUpload={() => navigate('/carregar-jogo', { view: 'loader' })}
        />
      );
    }

    if (route.view === 'loader') {
      return <RomLoaderView onLaunchRom={handleLaunchRom} />;
    }

    if (route.view === 'controls') {
      return (
        <ControlsConfigView
          initialConsoleId={route.consoleId ?? activeSession?.consoleDef.id ?? 'snes'}
          activeGameContext={
            activeSession
              ? {
                  gameId: activeSession.gameId,
                  gameName: activeSession.gameName,
                  consoleId: activeSession.consoleDef.id,
                }
              : null
          }
          onBackToGame={
            activeSession
              ? () =>
                  navigate(`/jogar/${activeSession.consoleDef.slug}`, {
                    view: 'play',
                    slug: activeSession.consoleDef.slug,
                  })
              : undefined
          }
        />
      );
    }

    if (route.view === 'saves') {
      return <SaveManagerView />;
    }

    if (route.view === 'console') {
      const consoleDef = getConsoleBySlug(route.slug);
      if (consoleDef) {
        return (
          <ConsolePage
            consoleDef={consoleDef}
            onLaunchRom={handleLaunchRom}
            onOpenControls={(consoleId) =>
              navigate('/controles', { view: 'controls', consoleId })
            }
          />
        );
      }
    }

    // Home Hub Website View
    return (
      <div className="space-y-10 max-w-6xl">
        {/* Hero Section */}
        <section className="rounded-2xl border border-white/10 bg-[#141821] p-6 sm:p-10">
          <div className="max-w-3xl space-y-4">
            <div className="text-xs font-medium text-orange-400">
              {CONSOLES.length} Emuladores Disponíveis · EmulatorJS WebAssembly · Conta: {user.username}
            </div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight leading-[1.12] [text-wrap:balance]">
              Hub de emulação retro direto no seu navegador
            </h1>
            <p className="text-base text-slate-300 leading-relaxed max-w-2xl">
              Escolha qualquer um dos {CONSOLES.length} emuladores disponíveis no menu lateral ou envie sua ROM. Todo jogo adicionado fica salvo na sua conta para jogar novamente com 1 clique.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => navigate('/carregar-jogo', { view: 'loader' })}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold transition-colors whitespace-nowrap"
              >
                <FileUp className="w-4 h-4" />
                Carregar Jogo (ROM)
              </button>
              <button
                type="button"
                onClick={() => navigate('/biblioteca', { view: 'library' })}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-white/15 text-slate-200 hover:text-white hover:bg-white/5 text-sm font-medium transition-colors whitespace-nowrap"
              >
                <FolderOpen className="w-4 h-4" />
                Minha Biblioteca ({libraryGames.length})
              </button>
              <button
                type="button"
                onClick={() => navigate('/ia', { view: 'ai' })}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-violet-400/30 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 text-sm font-medium transition-colors whitespace-nowrap"
              >
                <BrainCircuit className="w-4 h-4" />
                Centro Multi-IA
              </button>
              <button
                type="button"
                onClick={() => navigate('/otimizar', { view: 'optimizer' })}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 text-sm font-medium transition-colors whitespace-nowrap"
              >
                <Gauge className="w-4 h-4" />
                Otimizar Jogos
              </button>
              <button
                type="button"
                onClick={() => navigate('/controles', { view: 'controls' })}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-white/15 text-slate-200 hover:text-white hover:bg-white/5 text-sm font-medium transition-colors whitespace-nowrap"
              >
                <Settings className="w-4 h-4" />
                Configurar Controles
              </button>
                            <button
                type="button"
                onClick={() => navigate('/biblioteca', { view: 'library' })}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 text-sm font-medium transition-colors whitespace-nowrap"
              >
                <Cloud className="w-4 h-4" />
                {storageStatus?.configured ? 'Nuvem RetroHub ativa' : 'Ver armazenamento na nuvem'}
              </button>
            </div>
          </div>
        </section>

        {/* Saved Games Quick Section */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-xl font-bold text-white">
                Seus Jogos Salvos na Conta
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Jogos adicionados por você ficam salvos para abrir rapidamente sem reenviar o arquivo.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/ia', { view: 'ai' })}
              className="px-2.5 py-2 rounded-lg bg-violet-500/15 text-violet-200 text-left font-medium"
            >
              Centro IA
            </button>
            <button
              type="button"
              onClick={() => navigate('/biblioteca', { view: 'library' })}
              className="text-xs font-medium text-orange-400 hover:text-orange-300"
            >
              Gerenciar biblioteca completa
            </button>
          </div>

          {libraryGames.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/15 bg-[#141821] p-6 flex flex-wrap items-center justify-between gap-4">
              <div className="text-sm text-slate-300">
                Você ainda não adicionou nenhum jogo. Ao carregar uma ROM, ela será salva automaticamente aqui na conta <strong className="text-white">{user.username}</strong>.
              </div>
              <button
                type="button"
                onClick={() => navigate('/carregar-jogo', { view: 'loader' })}
                className="px-4 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold whitespace-nowrap"
              >
                Adicionar Jogo
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {libraryGames.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-white/10 bg-[#141821] p-4 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs text-orange-400 font-medium truncate">
                      {item.consoleName}
                    </div>
                    <div className="text-sm font-semibold text-white truncate">
                      {item.gameName}
                    </div>
                    <div className="text-[11px] font-mono-tabular text-slate-500">
                      {formatBytes(item.fileSize)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={openingSavedId === item.gameId}
                    onClick={() => handleQuickOpenSavedGame(item)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-xs font-semibold shrink-0"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    {openingSavedId === item.gameId ? 'Abrindo' : 'Jogar'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Core Capabilities Overview */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-white/10 bg-[#141821] p-5 space-y-2">
            <Gamepad2 className="w-5 h-5 text-orange-400" />
            <h2 className="text-base font-semibold text-white">
              Teclado, Bluetooth/USB e Mouse
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Remapeamento por ação para teclado no PC, captura instantânea de botões físicos via Gamepad API e suporte a mouse/light gun.
            </p>
          </div>

          <div className="rounded-xl border border-white/10 bg-[#141821] p-5 space-y-2">
            <Smartphone className="w-5 h-5 text-orange-400" />
            <h2 className="text-base font-semibold text-white">
              Touch Customizável no Mobile
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Controles virtuais na tela com editor drag-and-drop para posicionar D-Pad e botões sem sair da tela nem cobrir o jogo.
            </p>
          </div>

          <div className="rounded-xl border border-white/10 bg-[#141821] p-5 space-y-2">
            <HardDrive className="w-5 h-5 text-orange-400" />
            <h2 className="text-base font-semibold text-white">
              5 Slots de Save em IndexedDB
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Save states persistentes por conta e jogo no navegador, aviso para salvar ao sair e exportação/importação em arquivo local.
            </p>
          </div>
        </section>

        {/* Directory of All Available Emulators */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-white">
                Todos os {CONSOLES.length} Emuladores Disponíveis
              </h2>
              <span className="text-xs text-slate-400">
                Todos rodam 100% automaticamente no navegador sem precisar adicionar BIOS manual · Clique para abrir
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {CONSOLES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  navigate(`/console/${c.slug}`, { view: 'console', slug: c.slug })
                }
                className="text-left rounded-xl border border-white/10 bg-[#141821] hover:border-orange-500/50 hover:bg-[#181D29] p-4 transition-colors group"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white group-hover:text-orange-300 transition-colors truncate">
                    {c.name}
                  </span>
                  <span className="text-xs font-mono-tabular text-slate-500 shrink-0">
                    {c.year}
                  </span>
                </div>
                <div className="text-xs text-slate-400 mt-1 flex items-center justify-between gap-2">
                  <span className="truncate">
                    {c.manufacturer} ·{' '}
                    <span className="font-mono-tabular text-slate-500">
                      {c.extensions.slice(0, 3).join(', ')}
                    </span>
                  </span>
                  <span className="text-emerald-400 shrink-0">Automático</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0D12] text-[#F1F5F9]">
      {/* Top Bar Contract: Brand wordmark — 5 nav links — 1 primary CTA */}
      <header className="sticky top-0 z-40 h-16 border-b border-white/10 bg-[#0B0D12]/95 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between gap-8">
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="lg:hidden p-2 -ml-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/5"
            aria-label="Abrir lista de emuladores"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/', { view: 'home' });
            }}
            className="font-display text-xl font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            RetroHub
          </a>
        </div>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/', { view: 'home' });
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              route.view === 'home'
                ? 'text-white underline underline-offset-8 decoration-orange-500'
                : ''
            }`}
          >
            Consoles
          </a>
          <a
            href="/ia"
            onClick={(e) => { e.preventDefault(); navigate('/ia', { view: 'ai' }); }}
            className="hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Centro IA
          </a>
          <a
            href="/otimizar"
            onClick={(e) => { e.preventDefault(); navigate('/otimizar', { view: 'optimizer' }); }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${route.view === 'optimizer' ? 'text-white underline underline-offset-8 decoration-emerald-400' : ''}`}
          >
            Otimizar Jogos
          </a>
          <a
            href="/biblioteca"
            onClick={(e) => {
              e.preventDefault();
              navigate('/biblioteca', { view: 'library' });
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              route.view === 'library'
                ? 'text-white underline underline-offset-8 decoration-orange-500'
                : ''
            }`}
          >
            Biblioteca ({libraryGames.length})
          </a>
          <a
            href="/carregar-jogo"
            onClick={(e) => {
              e.preventDefault();
              navigate('/carregar-jogo', { view: 'loader' });
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              route.view === 'loader'
                ? 'text-white underline underline-offset-8 decoration-orange-500'
                : ''
            }`}
          >
            Carregar Jogo
          </a>
          <a
            href="/controles"
            onClick={(e) => {
              e.preventDefault();
              navigate('/controles', { view: 'controls' });
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              route.view === 'controls'
                ? 'text-white underline underline-offset-8 decoration-orange-500'
                : ''
            }`}
          >
            Controles
          </a>
          <a
            href="/saves"
            onClick={(e) => {
              e.preventDefault();
              navigate('/saves', { view: 'saves' });
            }}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              route.view === 'saves'
                ? 'text-white underline underline-offset-8 decoration-orange-500'
                : ''
            }`}
          >
            Saves
          </a>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => navigate('/carregar-jogo', { view: 'loader' })}
            className="px-4 py-2 rounded-lg bg-orange-500 hover:bg-orange-600 text-white text-xs sm:text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            Carregar ROM
          </button>
        </div>
      </header>

      {/* Main Website Body */}
      <div className="flex-1 flex relative">
        {mobileMenuOpen && (
          <div
            onClick={() => setMobileMenuOpen(false)}
            className="fixed inset-0 z-30 bg-black/70 lg:hidden"
          />
        )}

        {/* Sidebar with Account Info + All Emulators */}
        <aside
          className={`fixed lg:sticky top-16 left-0 z-30 h-[calc(100vh-4rem)] w-72 shrink-0 border-r border-white/10 bg-[#0E1118] flex flex-col transition-transform duration-200 ${
            mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
          }`}
        >
          {/* Logged-in User Account Bar */}
          <div className="p-3 border-b border-white/10 space-y-2 bg-[#11151E]">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-7 h-7 rounded-lg bg-orange-500/15 border border-orange-500/30 flex items-center justify-center text-orange-400 shrink-0">
                  <UserIcon className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white truncate">
                    {user.username}
                  </div>
                  <div className="text-[10px] text-slate-400">Conta conectada</div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                title="Sair da conta"
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-slate-400 hover:text-red-300 hover:bg-white/5 transition-colors shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sair
              </button>
            </div>

                        <button
              type="button"
              onClick={() => navigate('/biblioteca', { view: 'library' })}
              className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 text-[11px] font-medium transition-colors"
            >
              <span className="inline-flex items-center gap-1.5 min-w-0 truncate">
                <Cloud className="w-3.5 h-3.5 shrink-0 text-sky-400" />
                <span className="truncate">Armazenamento RetroHub</span>
              </span>
              <span className="text-[10px] shrink-0">
                {storageStatus?.configured ? 'Ativo' : 'A verificar'}
              </span>
            </button>
          </div>

          {/* Mobile Quick Nav */}
          <div className="md:hidden grid grid-cols-2 gap-1.5 p-3 border-b border-white/10 text-xs">
            <button
              type="button"
              onClick={() => navigate('/biblioteca', { view: 'library' })}
              className="px-2.5 py-2 rounded-lg bg-white/5 text-slate-200 text-left font-medium"
            >
              Biblioteca ({libraryGames.length})
            </button>
            <button
              type="button"
              onClick={() => navigate('/carregar-jogo', { view: 'loader' })}
              className="px-2.5 py-2 rounded-lg bg-white/5 text-slate-200 text-left font-medium"
            >
              Carregar Jogo
            </button>
            <button
              type="button"
              onClick={() => navigate('/otimizar', { view: 'optimizer' })}
              className="px-2.5 py-2 rounded-lg bg-emerald-500/10 text-emerald-200 text-left font-medium"
            >
              Otimizar Jogos
            </button>
            <button
              type="button"
              onClick={() => navigate('/controles', { view: 'controls' })}
              className="px-2.5 py-2 rounded-lg bg-white/5 text-slate-200 text-left font-medium"
            >
              Controles
            </button>
            <button
              type="button"
              onClick={() => navigate('/saves', { view: 'saves' })}
              className="px-2.5 py-2 rounded-lg bg-white/5 text-slate-200 text-left font-medium"
            >
              Saves
            </button>
          </div>

          {/* Search Filter for All Emulators */}
          <div className="p-3 border-b border-white/10">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={sidebarSearch}
                onChange={(e) => setSidebarSearch(e.target.value)}
                placeholder={`Filtrar ${CONSOLES.length} emuladores...`}
                aria-label="Filtrar emuladores"
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[#0B0D12] border border-white/10 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-5">
            {filteredConsolesByCategory.map((group) => (
              <div key={group.id}>
                <div className="px-2 mb-1.5 text-[11px] font-semibold text-slate-500">
                  {group.label}
                </div>
                <ul className="space-y-0.5">
                  {group.items.map((c) => {
                    const isCurrent = activeConsoleSlug === c.slug;
                    return (
                      <li key={c.id}>
                        <a
                          href={`/console/${c.slug}`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(`/console/${c.slug}`, {
                              view: 'console',
                              slug: c.slug,
                            });
                          }}
                          className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors ${
                            isCurrent
                              ? 'bg-orange-500/15 text-orange-300 font-semibold border border-orange-500/30'
                              : 'text-slate-300 hover:text-white hover:bg-white/[0.04]'
                          }`}
                        >
                          <span className="truncate">{c.name}</span>
                          <span className="font-mono-tabular text-[10px] text-slate-500 shrink-0">
                            {c.year}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 flex flex-col justify-between">
          <div>
            {libraryNotice && (
              <div
                className={`mb-4 px-4 py-2.5 rounded-lg border text-xs ${
                  libraryNotice.type === 'err'
                    ? 'border-red-500/30 bg-red-500/10 text-red-200'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                }`}
              >
                {libraryNotice.text}
              </div>
            )}
            {renderMainContent()}
          </div>

          <footer className="mt-14 pt-6 border-t border-white/10 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
            <div>
              RetroHub · {CONSOLES.length} emuladores via EmulatorJS / RetroArch WebAssembly. Este site não distribui ROMs públicas.
            </div>
            <div className="flex items-center gap-5">
              <button
                type="button"
                onClick={() => navigate('/biblioteca', { view: 'library' })}
                className="hover:text-slate-300 transition-colors"
              >
                Minha Biblioteca
              </button>
              <button
                type="button"
                onClick={() => navigate('/carregar-jogo', { view: 'loader' })}
                className="hover:text-slate-300 transition-colors"
              >
                Carregar Jogo
              </button>
              <button
                type="button"
                onClick={() => navigate('/controles', { view: 'controls' })}
                className="hover:text-slate-300 transition-colors"
              >
                Controles
              </button>
              <button
                type="button"
                onClick={() => navigate('/saves', { view: 'saves' })}
                className="hover:text-slate-300 transition-colors"
              >
                Saves
              </button>
            </div>
          </footer>
        </main>
      </div>


    </div>
  );
}
