import React, { useCallback, useEffect, useState } from 'react';
import { Bot, BrainCircuit, CircleAlert, Loader2, MessageSquare, RefreshCw, Send, ShieldCheck, Sparkles, Swords } from 'lucide-react';

type Message = { role: 'user' | 'assistant'; content: string };
type HistoryItem = { id: string; mode: 'chat' | 'debate'; title: string; updatedAt: string };
type AiStatus = { configured: boolean; provider: string; defaultModel: string; models: string[]; storage: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Não foi possível concluir o pedido.');
  return data as T;
}

export function AIHubView({ username }: { username: string }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [mode, setMode] = useState<'chat' | 'debate'>('chat');
  const [model, setModel] = useState('');
  const [topic, setTopic] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [sessionId, setSessionId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        api<AiStatus>('/api/ai/status'),
        api<{ sessions: HistoryItem[] }>('/api/ai/history')
      ]);
      setStatus(s);
      setHistory(h.sessions);
      setModel((current) => current || s.defaultModel || s.models[0] || '');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Erro ao carregar o centro de IA.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const startNew = () => { setSessionId(''); setMessages([]); setTopic(''); setNotice(''); };

  const send = async () => {
    const prompt = topic.trim();
    if (!prompt || busy) return;
    setBusy(true); setNotice('');
    try {
      if (mode === 'chat') {
        const next = [...messages, { role: 'user' as const, content: prompt }];
        setMessages(next); setTopic('');
        const result = await api<{ sessionId: string; message: string }>('/api/ai/chat', {
          method: 'POST', body: JSON.stringify({ sessionId, model, messages: next })
        });
        setSessionId(result.sessionId);
        setMessages([...next, { role: 'assistant', content: result.message }]);
      } else {
        const result = await api<{ sessionId: string; title: string; rounds: { model: string; answer: string }[]; verdict: string }>('/api/ai/debate', {
          method: 'POST', body: JSON.stringify({ sessionId, topic: prompt, model })
        });
        setSessionId(result.sessionId);
        setMessages([
          { role: 'user', content: 'Tema: ' + prompt },
          ...result.rounds.map((round) => ({ role: 'assistant' as const, content: round.model + '\n' + round.answer })),
          { role: 'assistant', content: 'AVALIAÇÃO FINAL\n' + result.verdict }
        ]);
        setTopic('');
      }
      const h = await api<{ sessions: HistoryItem[] }>('/api/ai/history');
      setHistory(h.sessions);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Falha ao contactar o motor de IA.');
    } finally { setBusy(false); }
  };

  const openHistory = async (id: string) => {
    setBusy(true); setNotice('');
    try {
      const data = await api<{ session: { id: string; mode: 'chat' | 'debate'; messages: Message[] } }>(`/api/ai/history/${encodeURIComponent(id)}`);
      setSessionId(data.session.id); setMode(data.session.mode); setMessages(data.session.messages); setTopic('');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Não foi possível abrir o histórico.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="rounded-2xl border border-violet-400/20 bg-gradient-to-br from-[#17152a] to-[#111722] p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-violet-300"><Sparkles className="h-4 w-4" /> RetroHub Intelligence</div>
            <h1 className="text-3xl font-bold text-white sm:text-4xl">Centro Multi-IA</h1>
            <p className="text-sm leading-relaxed text-slate-300">Conversa com um modelo de IA ou coloca diferentes perspetivas a analisar o mesmo tema. As sessões ficam associadas à tua conta.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-xs text-slate-300"><div className="font-semibold text-white">{username}</div><div>Conta RetroHub</div></div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="min-w-0 space-y-4 rounded-2xl border border-white/10 bg-[#11151e] p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex rounded-lg border border-white/10 bg-black/20 p-1">
              <button onClick={() => { setMode('chat'); startNew(); }} className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold ${mode === 'chat' ? 'bg-violet-500/20 text-violet-200' : 'text-slate-400'}`}><MessageSquare className="h-4 w-4"/> Conversa</button>
              <button onClick={() => { setMode('debate'); startNew(); }} className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs font-semibold ${mode === 'debate' ? 'bg-violet-500/20 text-violet-200' : 'text-slate-400'}`}><Swords className="h-4 w-4"/> Debate IA</button>
            </div>
            <button onClick={startNew} className="text-xs text-slate-400 hover:text-white">Nova sessão</button>
          </div>

          {notice && <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100"><CircleAlert className="h-4 w-4 shrink-0"/>{notice}</div>}

          {!status?.configured && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              <div className="mb-1 flex items-center gap-2 font-semibold"><CircleAlert className="h-4 w-4"/> Motor de IA ainda não configurado</div>
              O site já tem a interface e a API preparadas. Para ativar, é necessário configurar no servidor uma chave de fornecedor de IA e, opcionalmente, a URL de uma API compatível com OpenAI. A chave nunca é enviada ao navegador.
            </div>
          )}

          <div className="min-h-[280px] space-y-3 rounded-xl border border-white/10 bg-[#0b0e14] p-4">
            {messages.length === 0 ? (
              <div className="flex min-h-[245px] flex-col items-center justify-center text-center">
                <div className="mb-3 rounded-2xl border border-violet-400/20 bg-violet-400/10 p-4 text-violet-300"><BrainCircuit className="h-8 w-8"/></div>
                <div className="font-semibold text-white">{mode === 'chat' ? 'O que queres explorar?' : 'Que tema vamos debater?'}</div>
                <p className="mt-1 max-w-md text-xs text-slate-500">{mode === 'chat' ? 'Faz uma pergunta, pede ajuda com código ou explora uma ideia.' : 'O sistema compara argumentos de duas perspetivas e apresenta uma avaliação final.'}</p>
              </div>
            ) : messages.map((message, index) => (
              <div key={index} className={`rounded-xl p-3 text-sm leading-relaxed whitespace-pre-wrap ${message.role === 'user' ? 'ml-5 border border-violet-400/20 bg-violet-500/10 text-violet-50' : 'mr-3 border border-white/10 bg-white/[0.04] text-slate-200'}`}>
                <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">{message.role === 'user' ? 'Tu' : <><Bot className="h-3 w-3"/> RetroHub AI</>}</div>
                {message.content}
              </div>
            ))}
            {busy && <div className="flex items-center gap-2 text-xs text-violet-300"><Loader2 className="h-4 w-4 animate-spin"/> A IA está a preparar a resposta…</div>}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-slate-400" htmlFor="ai-model">Modelo</label>
              <select id="ai-model" value={model} onChange={(e) => setModel(e.target.value)} className="max-w-full rounded-lg border border-white/10 bg-[#0b0e14] px-3 py-2 text-xs text-slate-200">
                {(status?.models?.length ? status.models : ['configurar-no-servidor']).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <span className="text-[10px] text-slate-500">Fornecedor: {status?.provider || 'não configurado'}</span>
            </div>
            <div className="flex gap-2">
              <textarea value={topic} onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} rows={3} maxLength={8000} placeholder={mode === 'chat' ? 'Escreve a tua mensagem…' : 'Escreve o tema que as IAs vão debater…'} className="min-w-0 flex-1 resize-y rounded-xl border border-white/10 bg-[#0b0e14] p-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-violet-400/50" />
              <button disabled={!status?.configured || busy || !topic.trim()} onClick={() => void send()} className="self-end rounded-xl bg-violet-500 px-4 py-3 text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-40"><Send className="h-4 w-4"/></button>
            </div>
            <p className="text-[10px] text-slate-500">As respostas podem conter erros. Não introduzas palavras-passe, chaves privadas ou dados pessoais.</p>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-white/10 bg-[#11151e] p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-white"><ShieldCheck className="h-4 w-4 text-emerald-400"/> Estado do sistema</h2>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between gap-2"><span className="text-slate-400">Motor IA</span><span className={status?.configured ? 'text-emerald-300' : 'text-amber-300'}>{status?.configured ? 'Configurado' : 'Pendente'}</span></div>
              <div className="flex justify-between gap-2"><span className="text-slate-400">Histórico</span><span className="text-slate-200">{status?.storage || 'A verificar'}</span></div>
              <div className="flex justify-between gap-2"><span className="text-slate-400">Sessão</span><span className="text-slate-200">Privada</span></div>
            </div>
            <button onClick={() => void refresh()} className="mt-4 inline-flex items-center gap-2 text-xs text-violet-300 hover:text-violet-200"><RefreshCw className="h-3.5 w-3.5"/> Atualizar estado</button>
          </section>
          <section className="rounded-2xl border border-white/10 bg-[#11151e] p-4">
            <h2 className="mb-3 text-sm font-bold text-white">Histórico recente</h2>
            {history.length === 0 ? <p className="text-xs text-slate-500">Ainda não existem sessões guardadas.</p> : <div className="space-y-1">{history.map((item) => <button key={item.id} onClick={() => void openHistory(item.id)} className="w-full rounded-lg p-2 text-left hover:bg-white/5"><div className="truncate text-xs font-medium text-slate-200">{item.title}</div><div className="mt-1 text-[10px] text-slate-500">{item.mode === 'debate' ? 'Debate' : 'Conversa'} · {new Date(item.updatedAt).toLocaleString()}</div></button>)}</div>}
          </section>
        </aside>
      </div>
    </div>
  );
}
