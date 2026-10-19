// Servidor do Destrave: recebe o pedido do app, confere a sessão da pessoa e o limite diário,
// e repassa à API da Anthropic usando a chave guardada em segredo na Vercel.
// Variáveis de ambiente (painel da Vercel > Settings > Environment Variables):
//   ANTHROPIC_API_KEY   obrigatória: a chave do Console da Anthropic
//   SUPABASE_URL        obrigatória: a "Project URL" do Supabase
//   SUPABASE_ANON_KEY   obrigatória: a chave "anon public" do Supabase
//   MODELO_PADRAO       opcional (padrão claude-sonnet-5-5): gera os planos
//   MODELO_RAPIDO       opcional (padrão claude-haiku-5-5): responde o chat de suporte
//   LIMITE_DIARIO       opcional (padrão 40): chamadas à IA por pessoa por dia

const MAX_ENTRADA = 60000;      // caracteres por pedido (o plano usa cerca de 11 mil)
const MAX_SAIDA_JSON = 16000;   // tokens de resposta para o plano (inclui qualquer "pensamento" do modelo)
const MAX_SAIDA_TEXTO = 2000;   // tokens de resposta para o chat
const TEMPO_MAX = 280000;       // a Vercel gratuita encerra em 300 s

function modeloPara(tier) {
  if (tier === "quick") return process.env.MODELO_RAPIDO || "claude-haiku-5-5";
  return process.env.MODELO_PADRAO || "claude-sonnet-5-5";
}

// Os modelos 5.5 "pensam" antes de responder por padrão, e esse pensamento conta no limite de resposta.
// Para o plano e o chat não precisamos disso: desligamos do jeito que a documentação indica para cada modelo.
// (Haiku 5.5 aceita "disabled"; Sonnet 5.5 recusa "disabled" e usa "between_tools", que sem ferramentas não pensa antes.)
function pensamentoPara(modelo) {
  if (/haiku/i.test(modelo)) return { type: "disabled" };
  if (/sonnet-5/i.test(modelo)) return { type: "between_tools" };
  return undefined;
}

// A entrada do app é um texto ou uma lista de turnos. A API pede turnos alternados,
// começando e terminando com a pessoa ("user"): turnos seguidos do mesmo papel são juntados.
function montarMensagens(input) {
  let turnos;
  if (typeof input === "string") turnos = [{ role: "user", content: input }];
  else if (Array.isArray(input)) turnos = input.filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim());
  else return null;
  const out = [];
  for (const t of turnos) {
    const ult = out[out.length - 1];
    if (ult && ult.role === t.role) ult.content += "\n\n" + t.content;
    else out.push({ role: t.role, content: t.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

const tamanho = msgs => msgs.reduce((n, m) => n + m.content.length, 0);

async function contarUso(token) {
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  const r = await fetch(`${url}/rest/v1/rpc/usar_ia`, {
    method: "POST",
    headers: { apikey: anon, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  if (r.status >= 500) return { erro: "upstream_error" };
  if (!r.ok) return { erro: "not_granted" };
  const n = await r.json();
  return { n: Number(n) || 0 };
}

module.exports = async function handler(req, res) {
  // Cada falha também vai para os registros da Vercel (Projeto > Logs), para facilitar o diagnóstico.
  const falha = (status, code, message) => { console.error(`[api/ia] ${status} ${code}: ${message || code}`); return res.status(status).json({ code, message: message || code }); };
  if (req.method !== "POST") return falha(405, "invalid_request", "Use POST.");
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)
    return falha(500, "upstream_error", "Servidor sem configuração: confira as variáveis de ambiente na Vercel.");

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return falha(401, "not_granted", "Sem sessão.");

  let body;
  try { body = req.body || {}; } catch (e) { return falha(400, "invalid_request", "Pedido mal formado."); }
  const mensagens = montarMensagens(body.input);
  if (!mensagens) return falha(400, "invalid_request", "Pedido sem mensagem válida.");
  if (tamanho(mensagens) > MAX_ENTRADA) return falha(413, "prompt_too_large", "Pedido grande demais.");

  // Confere a sessão e conta o uso de hoje (a função usar_ia só aceita pessoas logadas).
  let uso;
  try { uso = await contarUso(token); } catch (e) { return falha(502, "upstream_error", "Base de dados fora do ar."); }
  if (uso.erro) return falha(uso.erro === "not_granted" ? 401 : 502, uso.erro);
  const limite = Number(process.env.LIMITE_DIARIO) || 40;
  if (uso.n > limite) return falha(429, "rate_limited", "Limite diário de uso da IA atingido.");

  const json = !!body.json;
  const modelo = modeloPara(body.modelTier);
  const pedido = {
    model: modelo,
    max_tokens: json ? MAX_SAIDA_JSON : MAX_SAIDA_TEXTO,
    messages: mensagens,
  };
  const pensamento = pensamentoPara(modelo);
  if (pensamento) pedido.thinking = pensamento;
  if (json) pedido.system = "Responda somente com um único valor JSON válido, sem nenhum texto antes ou depois, e sem bloco de código.";

  const inicio = Date.now();
  async function chamarIA(corpo) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(5000, TEMPO_MAX - (Date.now() - inicio)));
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(corpo),
        signal: ctl.signal,
      });
      let d = {};
      try { d = await resp.json(); } catch (e) {}
      return { r: resp, dados: d };
    } finally { clearTimeout(timer); }
  }

  let r, dados;
  try {
    ({ r, dados } = await chamarIA(pedido));
    // Se o modelo configurado não aceitar o ajuste de pensamento, tenta uma vez sem ele.
    const msg0 = (dados.error && dados.error.message) || "";
    if (r.status === 400 && pedido.thinking && /thinking/i.test(msg0)) {
      console.error(`[api/ia] modelo ${modelo} recusou thinking=${JSON.stringify(pedido.thinking)}: ${msg0}. Tentando sem.`);
      delete pedido.thinking;
      ({ r, dados } = await chamarIA(pedido));
    }
  } catch (e) {
    return falha(504, "upstream_error", "A IA demorou demais para responder.");
  }

  if (!r.ok) {
    // 429: limite da sua conta na Anthropic; 529: API sobrecarregada; 401: chave inválida.
    if (r.status === 429) return falha(429, "rate_limited", "Limite da API atingido.");
    if (r.status === 401 || r.status === 403) return falha(500, "upstream_error", "Chave da API inválida: confira ANTHROPIC_API_KEY.");
    const msgApi = (dados.error && dados.error.message) || "";
    if (/credit balance|billing|credits/i.test(msgApi)) return falha(502, "upstream_error", "Conta da Anthropic sem créditos: " + msgApi);
    if (r.status === 400) return falha(400, "invalid_request", msgApi || "Pedido recusado pela API.");
    return falha(502, "upstream_error", `A IA está indisponível agora (${r.status}${msgApi ? ": " + msgApi : ""}).`);
  }
  if (dados.stop_reason === "refusal") return falha(422, "refused", "A IA recusou o pedido.");
  const texto = (dados.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  if (!texto.trim()) {
    const tipos = (dados.content || []).map(b => b.type).join(",") || "nenhum";
    const uso = dados.usage ? ` (tokens de saída: ${dados.usage.output_tokens})` : "";
    return falha(502, "empty_completion", `A IA não devolveu texto. Motivo do fim: ${dados.stop_reason}; blocos: ${tipos}${uso}; modelo: ${modelo}.`);
  }
  return res.status(200).json({ text: texto, truncated: dados.stop_reason === "max_tokens" });
};

module.exports.montarMensagens = montarMensagens; // usado nos testes
