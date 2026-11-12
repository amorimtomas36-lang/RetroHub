import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Lock, User, UserPlus } from 'lucide-react';
import { CONSOLES } from '../data/consoles';
import {
  AuthUser,
  checkUsernameAvailability,
  loginAccount,
  registerAccount,
} from '../utils/api';

interface AuthPageProps {
  onAuthenticated: (user: AuthUser) => void;
}

export const AuthPage: React.FC<AuthPageProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [suggestRegister, setSuggestRegister] = useState(false);
  const [nameStatus, setNameStatus] = useState<{
    checking: boolean;
    available?: boolean;
    reason?: string;
  }>({ checking: false });

  // Live uniqueness check while creating an account
  useEffect(() => {
    if (mode !== 'register') {
      setNameStatus({ checking: false });
      return;
    }
    const trimmed = username.trim().replace(/\s+/g, ' ');
    if (!trimmed) {
      setNameStatus({ checking: false });
      return;
    }

    let cancelled = false;
    setNameStatus({ checking: true });
    const timer = setTimeout(async () => {
      try {
        const res = await checkUsernameAvailability(trimmed);
        if (!cancelled) {
          setNameStatus({
            checking: false,
            available: res.available,
            reason: res.reason,
          });
        }
      } catch {
        if (!cancelled) setNameStatus({ checking: false });
      }
    }, 240);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [username, mode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuggestRegister(false);
    const trimmed = username.trim().replace(/\s+/g, ' ');
    if (!trimmed || !password) {
      setErrorMsg('Preencha o nome da conta e a senha.');
      return;
    }

    setSubmitting(true);
    try {
      const user =
        mode === 'register'
          ? await registerAccount(trimmed, password)
          : await loginAccount(trimmed, password);
      onAuthenticated(user);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao autenticar.';
      setErrorMsg(msg);
      if (mode === 'login' && msg.toLowerCase().includes('incorretos')) {
        setSuggestRegister(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D12] text-[#F1F5F9] flex flex-col justify-between">
      <header className="h-16 border-b border-white/10 px-6 flex items-center justify-between">
        <span className="font-display text-xl font-bold tracking-tight text-white">
          RetroHub
        </span>
        <span className="text-xs text-slate-400">
          {CONSOLES.length} Emuladores · Biblioteca Salva por Conta
        </span>
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-5 rounded-2xl border border-white/10 bg-[#141821] overflow-hidden shadow-2xl">
          {/* Left Editorial Pitch */}
          <div className="lg:col-span-2 p-7 sm:p-8 bg-[#0F131B] border-b lg:border-b-0 lg:border-r border-white/10 flex flex-col justify-between space-y-6">
            <div className="space-y-3">
              <div className="text-xs font-medium text-orange-400">
                Acesso Exclusivo por Conta
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight [text-wrap:balance]">
                Sua biblioteca retro salva na sua conta
              </h1>
              <p className="text-sm text-slate-300 leading-relaxed">
                Entre com seu nome de conta e senha para acessar todos os {CONSOLES.length} emuladores automáticos, salvar os seus jogos adicionados na biblioteca e manter seus save states e controles configurados.
              </p>
            </div>

            <div className="space-y-2.5 text-xs text-slate-400 pt-4 border-t border-white/10">
              <div>· Nome de conta único: ninguém pode criar conta com nome igual ao seu.</div>
              <div>· Jogos enviados ficam salvos na sua biblioteca pessoal para abrir com 1 clique.</div>
              <div>· Funciona no celular, tablet e PC com controle Bluetooth/USB, teclado e touch.</div>
            </div>
          </div>

          {/* Right Auth Form */}
          <div className="lg:col-span-3 p-7 sm:p-8 space-y-6">
            <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B0D12] border border-white/10">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setErrorMsg(null);
                  setSuggestRegister(false);
                }}
                className={`flex-1 py-2 px-4 rounded-lg text-sm font-semibold transition-colors ${
                  mode === 'login'
                    ? 'bg-orange-500 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Entrar na Conta
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setErrorMsg(null);
                  setSuggestRegister(false);
                }}
                className={`flex-1 py-2 px-4 rounded-lg text-sm font-semibold transition-colors ${
                  mode === 'register'
                    ? 'bg-orange-500 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Criar Conta
              </button>
            </div>

            <div>
              <h2 className="text-xl font-bold text-white">
                {mode === 'login' ? 'Fazer login no RetroHub' : 'Criar nova conta'}
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                {mode === 'login'
                  ? 'Digite o nome da sua conta e a senha cadastrada.'
                  : 'Escolha um nome único (ninguém poderá usar um nome igual) e uma senha.'}
              </p>
            </div>

            {errorMsg && (
              <div className="p-3.5 rounded-lg border border-red-500/35 bg-red-500/10 text-xs text-red-200 space-y-2">
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
                {suggestRegister && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('register');
                      setErrorMsg(null);
                      setSuggestRegister(false);
                    }}
                    className="text-orange-300 hover:text-orange-200 font-semibold underline underline-offset-4"
                  >
                    Primeiro acesso neste dispositivo? Criar conta com "{username.trim()}"
                  </button>
                )}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="auth-username"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Nome da conta
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-username"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Ex: jogador_retro"
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-lg bg-[#0B0D12] border border-white/15 text-base sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500"
                    required
                  />
                </div>

                {mode === 'register' && username.trim().length > 0 && (
                  <div className="mt-1.5 text-xs">
                    {nameStatus.checking ? (
                      <span className="text-slate-400">Verificando disponibilidade do nome...</span>
                    ) : nameStatus.available === true ? (
                      <span className="text-emerald-400 inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Nome disponível e exclusivo para você
                      </span>
                    ) : nameStatus.available === false ? (
                      <span className="text-red-400 inline-flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {nameStatus.reason}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>

              <div>
                <label
                  htmlFor="auth-password"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Senha
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? 'Mínimo 4 caracteres' : 'Sua senha'}
                    className="w-full pl-10 pr-10 py-2.5 rounded-lg bg-[#0B0D12] border border-white/15 text-base sm:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={
                  submitting ||
                  (mode === 'register' && nameStatus.available === false)
                }
                className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-semibold transition-colors"
              >
                {mode === 'register' ? (
                  <>
                    <UserPlus className="w-4 h-4" />
                    {submitting ? 'Criando conta...' : 'Criar Conta e Entrar'}
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4" />
                    {submitting ? 'Entrando...' : 'Entrar no Site'}
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </main>

      <footer className="py-4 px-6 border-t border-white/10 text-center text-xs text-slate-500">
        RetroHub · O site não hospeda nem distribui ROMs; apenas salva na sua conta os arquivos enviados por você.
      </footer>
    </div>
  );
};
