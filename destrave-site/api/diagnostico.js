// Diagnóstico da configuração. Abra no navegador: https://SEU-SITE/api/diagnostico
// Mostra só o que está certo ou errado, nunca as chaves. Faz uma chamada mínima à IA (custo desprezível).
// Depois que tudo estiver funcionando, pode apagar este arquivo do GitHub.

module.exports = async function handler(req, res) {
  const r = { variaveis: {}, supabase: "", anthropic: "", conclusao: [] };
  const key = process.env.ANTHROPIC_API_KEY || "", url = process.env.SUPABASE_URL || "", anon = process.env.SUPABASE_ANON_KEY || "";

  r.variaveis.ANTHROPIC_API_KEY = key ? (key.startsWith("sk-ant-") ? "ok" : "preenchida, mas não parece uma chave da Anthropic (deveria começar com sk-ant-)") : "FALTANDO";
  r.variaveis.SUPABASE_URL = url ? (/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) ? "ok" : "formato errado: use https://<projeto>.supabase.co, sem /rest/v1 e sem barra no fim") : "FALTANDO";
  r.variaveis.SUPABASE_ANON_KEY = anon ? (anon.length > 20 ? "ok" : "parece incompleta") : "FALTANDO";

  // Supabase: a função usar_ia existe? (sem sessão, ela deve recusar; se não existir, o SQL não foi rodado)
  if (url && anon) {
    try {
      const s = await fetch(`${url}/rest/v1/rpc/usar_ia`, { method: "POST", headers: { apikey: anon, "content-type": "application/json" }, body: "{}" });
      const t = await s.text();
      if (/Could not find the function|PGRST202/i.test(t)) r.supabase = "o banco responde, mas a função usar_ia não existe: rode o supabase.sql no SQL Editor";
      else if (s.status === 401 || s.status === 403 || /permission denied/i.test(t)) r.supabase = "ok (banco e função encontrados)";
      else if (s.status >= 500) r.supabase = `o Supabase respondeu com erro ${s.status}`;
      else r.supabase = `resposta inesperada (${s.status}): ${t.slice(0, 160)}`;
    } catch (e) { r.supabase = "não foi possível falar com o Supabase: confira SUPABASE_URL"; }
  } else r.supabase = "não testado (faltam variáveis)";

  // Anthropic: chamada mínima
  if (key) {
    try {
      const a = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.MODELO_RAPIDO || "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "oi" }] }),
      });
      const d = await a.json().catch(() => ({}));
      const msg = (d.error && d.error.message) || "";
      if (a.ok) r.anthropic = "ok (chave válida e com créditos)";
      else if (a.status === 401) r.anthropic = "chave inválida: crie outra no Console e troque ANTHROPIC_API_KEY";
      else if (/credit balance|billing|credits/i.test(msg)) r.anthropic = "sem créditos: adicione créditos em Settings > Billing no Console da Anthropic";
      else if (a.status === 404) r.anthropic = "modelo não encontrado: " + msg;
      else if (a.status === 429) r.anthropic = "limite de uso da conta atingido: " + msg;
      else r.anthropic = `erro ${a.status}: ${msg}`;
    } catch (e) { r.anthropic = "não foi possível falar com a Anthropic"; }
  } else r.anthropic = "não testado (falta a chave)";

  const ruins = Object.entries(r.variaveis).filter(([, v]) => v !== "ok").map(([k, v]) => `${k}: ${v}`);
  if (ruins.length) r.conclusao.push("Corrija as variáveis na Vercel (Settings > Environment Variables) e depois faça Redeploy: " + ruins.join(" | "));
  if (!r.supabase.startsWith("ok")) r.conclusao.push("Supabase: " + r.supabase);
  if (!r.anthropic.startsWith("ok")) r.conclusao.push("Anthropic: " + r.anthropic);
  if (!r.conclusao.length) r.conclusao.push("Tudo certo. Se a geração ainda falhar, confira se o login anônimo está ligado no Supabase (Authentication > Providers).");
  res.setHeader("cache-control", "no-store");
  return res.status(200).json(r);
};
