import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Cloud,
  ExternalLink,
  Loader2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import {
  TeraBoxDeviceCodeInfo,
  TeraBoxStatus,
  exchangeTeraBoxCode,
  pollTeraBoxDeviceCode,
  startTeraBoxDeviceCode,
} from '../utils/api';

interface TeraBoxConnectModalProps {
  open: boolean;
  status: TeraBoxStatus | null;
  onClose: () => void;
  onConnected: () => Promise<void> | void;
}

type ConnectMode = 'web' | 'qr';

function isTrustedTeraBoxOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === 'terabox.com' ||
      host.endsWith('.terabox.com') ||
      host === 'terabox.app' ||
      host.endsWith('.terabox.app') ||
      host === '1024tera.com' ||
      host.endsWith('.1024tera.com')
    );
  } catch {
    return false;
  }
}

export const TeraBoxConnectModal: React.FC<TeraBoxConnectModalProps> = ({
  open,
  status,
  onClose,
  onConnected,
}) => {
  const [mode, setMode] = useState<ConnectMode>('web');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [deviceInfo, setDeviceInfo] = useState<TeraBoxDeviceCodeInfo | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const exchangedCodeRef = useRef<string | null>(null);

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) {
      stopPolling();
      setErrorMsg(null);
      setSuccessMsg(null);
      setDeviceInfo(null);
      exchangedCodeRef.current = null;
    }
    return () => stopPolling();
  }, [open]);

  // Listen to postMessage from TeraBox outside/login iframe
  useEffect(() => {
    if (!open || !status?.configured || mode !== 'web') return;

    const handleMessage = async (event: MessageEvent) => {
      if (!isTrustedTeraBoxOrigin(event.origin)) return;
      // Only accept OAuth messages sent by the official login iframe itself.
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;

      let payload: Record<string, unknown> | null = null;
      if (typeof event.data === 'string') {
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
      } else if (event.data && typeof event.data === 'object') {
        payload = event.data as Record<string, unknown>;
      }
      if (!payload) return;

      if (payload.event !== 'teraboxOauth') return;
      const nestedData =
        payload.data && typeof payload.data === 'object'
          ? (payload.data as Record<string, unknown>)
          : null;
      const code = String(nestedData?.code ?? payload.code ?? '').trim();
      if (!code || exchangedCodeRef.current === code) return;

      exchangedCodeRef.current = code;
      setBusy(true);
      setErrorMsg(null);
      try {
        const res = await exchangeTeraBoxCode(code);
        setSuccessMsg(`Conta TeraBox (${res.uname}) conectada com sucesso!`);
        await onConnected();
        window.setTimeout(() => {
          onClose();
        }, 900);
      } catch (err) {
        exchangedCodeRef.current = null;
        setErrorMsg(
          err instanceof Error ? err.message : 'Não foi possível concluir o login do TeraBox.'
        );
      } finally {
        setBusy(false);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [open, status?.configured, mode, onConnected, onClose]);

  const loadQrCode = async () => {
    stopPolling();
    setErrorMsg(null);
    setQrLoading(true);
    setDeviceInfo(null);
    try {
      const info = await startTeraBoxDeviceCode();
      setDeviceInfo(info);

      const intervalMs = Math.max(2000, (info.interval || 2) * 1000);
      const deadline = Date.now() + (info.expiresIn || 300) * 1000;

      const scheduleNext = () => {
        pollTimerRef.current = window.setTimeout(async () => {
          if (Date.now() > deadline) {
            setErrorMsg('QR Code expirou. Clique em Atualizar QR Code para gerar outro.');
            return;
          }
          try {
            const poll = await pollTeraBoxDeviceCode(info.deviceCode);
            if (poll.status === 'connected') {
              setSuccessMsg(
                `Conta TeraBox (${poll.uname || 'Conectada'}) vinculada automaticamente!`
              );
              await onConnected();
              window.setTimeout(() => {
                onClose();
              }, 900);
              return;
            }
            if (poll.status === 'error') {
              setErrorMsg(poll.error || 'QR Code inválido ou expirado.');
              return;
            }
            scheduleNext();
          } catch {
            scheduleNext();
          }
        }, intervalMs);
      };

      scheduleNext();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Erro ao solicitar QR Code do TeraBox.'
      );
    } finally {
      setQrLoading(false);
    }
  };

  useEffect(() => {
    if (open && status?.configured && mode === 'qr' && !deviceInfo && !qrLoading) {
      loadQrCode();
    }
    if (mode !== 'qr') {
      stopPolling();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, status?.configured]);

  if (!open) return null;

  const clientId = status?.clientId || '';
  const iframeUrl = clientId
    ? `https://www.terabox.com/wap/outside/login?clientId=${encodeURIComponent(clientId)}`
    : '';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="terabox-modal-title"
    >
      <div className="w-full max-w-xl rounded-2xl border border-white/15 bg-[#121620] text-slate-100 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between gap-3 bg-[#0E1118]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <Cloud className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 id="terabox-modal-title" className="text-sm sm:text-base font-bold text-white truncate">
                Conectar TeraBox (1 TB Grátis)
              </h2>
              <p className="text-[11px] text-slate-400 truncate">
                Todos os seus jogos enviados vão direto para sua nuvem TeraBox automaticamente
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Fechar janela TeraBox"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!status ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-xs text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
              <span>Verificando integração TeraBox no servidor...</span>
            </div>
          ) : !status.configured ? (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3 text-xs text-amber-100 leading-relaxed">
              <div className="font-semibold text-sm text-white">
                Configuração do Servidor TeraBox Pendente
              </div>
              <p>
                Para liberar o login 100% automático da conta TeraBox para todos os usuários do site, o administrador precisa definir as 3 variáveis de ambiente do aplicativo no servidor:
              </p>
              <div className="rounded-lg bg-black/40 border border-white/10 p-3 font-mono-tabular text-[11px] text-sky-300 space-y-1">
                <div>TERABOX_CLIENT_ID=...</div>
                <div>TERABOX_CLIENT_SECRET=...</div>
                <div>TERABOX_PRIVATE_SECRET=...</div>
              </div>
              <p className="text-slate-300">
                Essas credenciais são gratuitas e obtidas no portal oficial da TeraBox Open Platform. Assim que forem configuradas no servidor, qualquer jogador poderá entrar com 1 clique aqui.
              </p>
              <a
                href="https://www.terabox.com/integrations/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sky-300 hover:text-sky-200 font-semibold"
              >
                Abrir portal TeraBox Open Platform
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          ) : (
            <>
              {/* Mode selector */}
              <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-[#0B0D12] border border-white/10">
                <button
                  type="button"
                  onClick={() => setMode('web')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-colors ${
                    mode === 'web'
                      ? 'bg-sky-500 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Entrar pelo Navegador
                </button>
                <button
                  type="button"
                  onClick={() => setMode('qr')}
                  className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold transition-colors ${
                    mode === 'qr'
                      ? 'bg-sky-500 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <QrCode className="w-3.5 h-3.5" />
                  QR Code (App TeraBox)
                </button>
              </div>

              {errorMsg && (
                <div className="px-3.5 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-200">
                  {errorMsg}
                </div>
              )}

              {successMsg && (
                <div className="px-3.5 py-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-200 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>{successMsg}</span>
                </div>
              )}

              {mode === 'web' ? (
                <div className="space-y-3">
                  <div className="relative rounded-xl border border-white/10 bg-white overflow-hidden h-[420px]">
                    {busy && (
                      <div className="absolute inset-0 z-10 bg-[#0B0D12]/90 flex flex-col items-center justify-center gap-2 text-xs text-white">
                        <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                        <span>Conectando sua conta TeraBox ao RetroHub...</span>
                      </div>
                    )}
                    {iframeUrl && (
                      <iframe
                        ref={iframeRef}
                        src={iframeUrl}
                        title="Login Oficial TeraBox"
                        className="w-full h-full border-0"
                        allow="clipboard-read; clipboard-write"
                      />
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 text-center">
                    Se preferir confirmar direto no celular sem digitar senha, mude para a aba <strong className="text-slate-200">QR Code (App TeraBox)</strong>.
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-[#0B0D12] p-6 flex flex-col items-center text-center space-y-4">
                  {qrLoading ? (
                    <div className="py-10 flex flex-col items-center gap-2 text-xs text-slate-400">
                      <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                      <span>Gerando QR Code oficial do TeraBox...</span>
                    </div>
                  ) : deviceInfo?.qrcodeUrl ? (
                    <>
                      <div className="p-3 rounded-xl bg-white">
                        <img
                          src={deviceInfo.qrcodeUrl}
                          alt="QR Code para conectar TeraBox"
                          className="w-44 h-44 object-contain"
                        />
                      </div>
                      <div className="space-y-1 max-w-sm">
                        <div className="text-xs font-semibold text-white flex items-center justify-center gap-1.5">
                          <Smartphone className="w-3.5 h-3.5 text-sky-400" />
                          Escaneie com o app TeraBox no celular
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          Abra o aplicativo TeraBox no seu celular, toque no ícone de leitor QR e confirme a permissão. A conexão será detectada automaticamente aqui.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={loadQrCode}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-slate-300 hover:text-white hover:bg-white/5 transition-colors"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Atualizar QR Code
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={loadQrCode}
                      className="px-4 py-2 rounded-lg bg-sky-500 hover:bg-sky-600 text-white text-xs font-semibold"
                    >
                      Gerar QR Code TeraBox
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
