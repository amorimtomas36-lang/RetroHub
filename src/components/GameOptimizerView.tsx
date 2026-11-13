import React, { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, Cpu, Gauge, Gamepad2, Monitor, RotateCcw, ShieldCheck, Smartphone, Sparkles, Zap } from 'lucide-react';
import { CONSOLES } from '../data/consoles';
import type { LibraryGameItem } from '../utils/api';
import {
  canUseEmulatorThreads,
  inspectGameDevice,
  loadGameOptimizationProfile,
  removeGameOptimizationProfile,
  saveGameOptimizationProfile,
  type GameDeviceInfo,
} from '../utils/gameOptimizer';

interface GameOptimizerViewProps {
  games: LibraryGameItem[];
}

const HEAVY_CONSOLES = new Set(['n64', 'nds', 'psx', 'psp', 'segaSaturn', 'sega32x', '3do', 'jaguar']);
type GameCondition = 'unknown' | 'smooth' | 'slow';

function valueOrUnknown(value: number | null, suffix = ''): string {
  return value === null ? 'Não divulgado pelo navegador' : value + suffix;
}

export function GameOptimizerView({ games }: GameOptimizerViewProps) {
  const firstTarget = games[0] ? `game:${games[0].gameId}` : `console:${CONSOLES[0]?.id ?? 'nes'}`;
  const [target, setTarget] = useState(firstTarget);
  const [condition, setCondition] = useState<GameCondition>('unknown');
  const [device, setDevice] = useState<GameDeviceInfo | null>(null);
  const [scanning, setScanning] = useState(true);
  const [result, setResult] = useState('');
  const [resultKind, setResultKind] = useState<'ok' | 'info' | 'warn'>('info');

  useEffect(() => {
    let active = true;
    inspectGameDevice()
      .then((info) => {
        if (active) setDevice(info);
      })
      .catch(() => {
        if (active) setDevice(null);
      })
      .finally(() => {
        if (active) setScanning(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selected = useMemo(() => {
    if (target.startsWith('game:')) {
      const game = games.find((item) => item.gameId === target.slice(5));
      if (game) {
        const consoleDef = CONSOLES.find((item) => item.id === game.consoleId);
        return {
          name: game.gameName,
          gameId: game.gameId,
          consoleId: game.consoleId,
          consoleName: consoleDef?.name ?? game.consoleName,
        };
      }
    }
    const consoleId = target.startsWith('console:') ? target.slice(8) : CONSOLES[0]?.id ?? 'nes';
    const consoleDef = CONSOLES.find((item) => item.id === consoleId) ?? CONSOLES[0];
    return {
      name: consoleDef?.name ?? 'Sistema',
      gameId: `console:${consoleDef?.id ?? consoleId}`,
      consoleId: consoleDef?.id ?? consoleId,
      consoleName: consoleDef?.name ?? consoleId,
    };
  }, [games, target]);

  const savedProfile = useMemo(
    () => loadGameOptimizationProfile(selected.consoleId, selected.gameId),
    [selected.consoleId, selected.gameId, result]
  );

  const runOptimization = () => {
    setResult('');
    if (!device) {
      setResultKind('warn');
      setResult('Não foi possível ler os dados do dispositivo. Atualiza a página e tenta novamente.');
      return;
    }
    if (condition === 'unknown') {
      setResultKind('info');
      setResult('Primeiro abre este jogo e confirma se está fluido ou se apresenta quebras. Assim evitamos alterar jogos que já estão a funcionar bem.');
      return;
    }
    if (condition === 'smooth') {
      setResultKind('ok');
      setResult('O jogo está fluido. Não alterei nenhuma definição e mantive o perfil atual.');
      return;
    }

    const demanding = HEAVY_CONSOLES.has(selected.consoleId);
    const threadsAvailable = canUseEmulatorThreads(device);
    const enableThreads = demanding && threadsAvailable;
    const useLegacyCore = demanding && !enableThreads && device.tier === 'low' && device.webgl2;

    if (!enableThreads && !useLegacyCore) {
      setResultKind('warn');
      setResult(
        'Detetei um jogo com quebras, mas este navegador não expõe uma alteração automática segura para este dispositivo. Mantive as definições originais para não piorar o desempenho. Podes fechar separadores pesados e voltar a testar.'
      );
      return;
    }

    const reasons = enableThreads
      ? 'Ativei o modo multithread do EmulatorJS, suportado por este navegador e pelo dispositivo.'
      : 'Ativei o núcleo gráfico legado WebGL 1 como alternativa para este dispositivo de recursos limitados.';

    saveGameOptimizationProfile(selected.consoleId, selected.gameId, {
      threads: enableThreads,
      forceLegacyCores: useLegacyCore,
      updatedAt: Date.now(),
      reason: reasons,
    });
    setResultKind('ok');
    setResult(`${reasons} O perfil ficou guardado apenas para “${selected.name}” e será aplicado quando iniciares esse jogo novamente.`);
  };

  const resetProfile = () => {
    removeGameOptimizationProfile(selected.consoleId, selected.gameId);
    setResultKind('info');
    setResult('Perfil personalizado removido. O jogo volta a usar as definições normais na próxima abertura.');
    setCondition('unknown');
  };

  const tierLabel =
    device?.tier === 'high' ? 'Alto desempenho' :
    device?.tier === 'medium' ? 'Desempenho intermédio' :
    device?.tier === 'low' ? 'Recursos limitados' : 'Não foi possível classificar';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-[#14251f] to-[#111722] p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-300">
              <Gauge className="h-4 w-4" /> RetroHub Performance
            </div>
            <h1 className="text-3xl font-bold text-white sm:text-4xl">Otimizar jogos</h1>
            <p className="text-sm leading-relaxed text-slate-300">
              Analisa o hardware disponível e guarda um perfil específico para cada jogo. Se disseres que o jogo já corre bem, o RetroHub não altera nada.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-slate-300">
            <div className="font-semibold text-white">{scanning ? 'A analisar dispositivo…' : tierLabel}</div>
            <div>Diagnóstico local</div>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-5 rounded-2xl border border-white/10 bg-[#11151e] p-4 sm:p-5">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <Gamepad2 className="h-4 w-4 text-emerald-300" /> Jogo a otimizar
          </div>

          <div className="space-y-2">
            <label htmlFor="optimizer-game" className="text-xs text-slate-400">Escolhe um jogo da biblioteca ou um sistema</label>
            <select
              id="optimizer-game"
              value={target}
              onChange={(event) => { setTarget(event.target.value); setResult(''); setCondition('unknown'); }}
              className="w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-3 text-sm text-white outline-none focus:border-emerald-400/50"
            >
              {games.length > 0 && <optgroup label="Jogos da minha biblioteca">
                {games.map((game) => <option key={game.id} value={`game:${game.gameId}`}>{game.gameName} · {game.consoleName}</option>)}
              </optgroup>}
              <optgroup label="Escolher sistema">
                {CONSOLES.map((item) => <option key={item.id} value={`console:${item.id}`}>{item.name}</option>)}
              </optgroup>
            </select>
            <p className="text-[11px] text-slate-500">
              {selected.name} · {selected.consoleName}
            </p>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-bold text-white">Como está a correr?</div>
            <div className="grid gap-2 sm:grid-cols-3">
              <button type="button" onClick={() => { setCondition('smooth'); setResult(''); }} className={`rounded-xl border p-3 text-left transition ${condition === 'smooth' ? 'border-emerald-400/60 bg-emerald-400/10' : 'border-white/10 bg-black/10 hover:bg-white/5'}`}>
                <CheckCircle2 className={`mb-2 h-5 w-5 ${condition === 'smooth' ? 'text-emerald-300' : 'text-slate-500'}`} />
                <div className="text-sm font-semibold text-white">Está fluido</div>
                <div className="mt-1 text-[11px] text-slate-400">Não alterar nada</div>
              </button>
              <button type="button" onClick={() => { setCondition('slow'); setResult(''); }} className={`rounded-xl border p-3 text-left transition ${condition === 'slow' ? 'border-amber-400/60 bg-amber-400/10' : 'border-white/10 bg-black/10 hover:bg-white/5'}`}>
                <Activity className={`mb-2 h-5 w-5 ${condition === 'slow' ? 'text-amber-300' : 'text-slate-500'}`} />
                <div className="text-sm font-semibold text-white">Tem quebras</div>
                <div className="mt-1 text-[11px] text-slate-400">Procurar um perfil melhor</div>
              </button>
              <button type="button" onClick={() => { setCondition('unknown'); setResult(''); }} className={`rounded-xl border p-3 text-left transition ${condition === 'unknown' ? 'border-sky-400/60 bg-sky-400/10' : 'border-white/10 bg-black/10 hover:bg-white/5'}`}>
                <Monitor className={`mb-2 h-5 w-5 ${condition === 'unknown' ? 'text-sky-300' : 'text-slate-500'}`} />
                <div className="text-sm font-semibold text-white">Ainda não testei</div>
                <div className="mt-1 text-[11px] text-slate-400">Não aplicar alterações</div>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={runOptimization} disabled={scanning || !device} className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
              <Sparkles className="h-4 w-4" /> Analisar e otimizar
            </button>
            <button type="button" onClick={resetProfile} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2.5 text-xs text-slate-300 transition hover:bg-white/5">
              <RotateCcw className="h-3.5 w-3.5" /> Repor perfil
            </button>
          </div>

          {result && (
            <div role="status" className={`rounded-xl border p-3 text-sm leading-relaxed ${resultKind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : resultKind === 'warn' ? 'border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border-sky-500/30 bg-sky-500/10 text-sky-100'}`}>
              {result}
            </div>
          )}

          {savedProfile && (
            <div className="rounded-xl border border-white/10 bg-black/15 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-200"><ShieldCheck className="h-4 w-4" /> Perfil personalizado guardado</div>
              <p className="mt-1 text-xs text-slate-400">{savedProfile.reason || 'Definições específicas guardadas para este jogo.'}</p>
              <p className="mt-1 text-[10px] text-slate-500">Será carregado ao iniciares o jogo novamente.</p>
            </div>
          )}
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-white/10 bg-[#11151e] p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-white"><Smartphone className="h-4 w-4 text-emerald-300" /> Dispositivo identificado</h2>
            {scanning ? <p className="text-xs text-slate-400">A recolher dados disponíveis…</p> : device ? (
              <div className="space-y-3 text-xs">
                <div><div className="text-slate-500">Modelo / dispositivo</div><div className="mt-0.5 break-words font-semibold text-white">{device.deviceName}</div></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><div className="text-slate-500">CPU / núcleos</div><div className="mt-0.5 font-semibold text-white">{valueOrUnknown(device.cpuCores, ' lógicos')}</div></div>
                  <div><div className="text-slate-500">RAM estimada</div><div className="mt-0.5 font-semibold text-white">{valueOrUnknown(device.memoryGB, ' GB')}</div></div>
                </div>
                <div><div className="text-slate-500">GPU</div><div className="mt-0.5 break-words font-semibold text-white">{device.gpu}</div></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><div className="text-slate-500">Gráficos</div><div className="mt-0.5 font-semibold text-white">{device.graphicsApi}</div></div>
                  <div><div className="text-slate-500">Ecrã</div><div className="mt-0.5 font-semibold text-white">{device.screen} · {device.pixelRatio}x</div></div>
                </div>
                <div><div className="text-slate-500">Sistema / navegador</div><div className="mt-0.5 break-words font-semibold text-white">{device.platform} · {device.browser}</div></div>
                <div className="flex items-center justify-between border-t border-white/10 pt-3"><span className="text-slate-400">WebGL 2</span><span className={device.webgl2 ? 'text-emerald-300' : 'text-amber-300'}>{device.webgl2 ? 'Disponível' : 'Indisponível'}</span></div>
                <div className="flex items-center justify-between"><span className="text-slate-400">Multithread</span><span className={canUseEmulatorThreads(device) ? 'text-emerald-300' : 'text-slate-400'}>{canUseEmulatorThreads(device) ? 'Disponível' : 'Não disponível'}</span></div>
              </div>
            ) : <p className="text-xs text-amber-200">O navegador não disponibilizou os dados do dispositivo.</p>}
          </section>

          <section className="rounded-2xl border border-white/10 bg-[#11151e] p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-white"><Cpu className="h-4 w-4 text-sky-300" /> Limites de acesso</h2>
            <p className="text-xs leading-relaxed text-slate-400">Por segurança, uma página web não consegue listar processos Android, ler a utilização real de cada processo, nem alterar clocks da CPU/GPU ou definições de outros jogos. O diagnóstico usa apenas os dados expostos pelo navegador.</p>
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-black/20 p-2.5 text-[11px] text-slate-400">
              <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
              A RAM apresentada é uma estimativa do navegador e a identificação da GPU pode estar ocultada pelo sistema.
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
