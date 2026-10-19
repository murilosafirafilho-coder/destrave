/* Ponte do Destrave: faz o app (escrito para rodar dentro do Claude) funcionar no seu próprio site.
   O app pede três recursos: "sample" (IA), "user" (quem está usando) e "db" (base de dados).
   Aqui eles são atendidos pelo seu servidor (/api/ia, que fala com a Anthropic) e pelo Supabase.
   Cada aparelho recebe uma sessão anônima do Supabase; não é preciso conta no Claude. */
(function () {
  "use strict";
  var cfg = window.DESTRAVE_CONFIG || {};
  var sb = null;
  var pronto;

  var urlOk = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(String(cfg.SUPABASE_URL || ""));
  var chaveOk = String(cfg.SUPABASE_ANON_KEY || "").length > 20 && !/COLE_AQUI/.test(cfg.SUPABASE_ANON_KEY);
  if (!urlOk || !chaveOk) {
    console.error("Destrave: config.js sem os dados do Supabase. SUPABASE_URL deve ser https://<projeto>.supabase.co (sem /rest/v1) e SUPABASE_ANON_KEY a chave anon public.");
  }
  // Uma configuração errada nunca derruba a ponte: o app continua abrindo e mostra a falha na geração.
  try {
    if (window.supabase && urlOk && chaveOk) {
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "destrave-sessao" },
      });
    }
  } catch (e) {
    console.error("Destrave: não foi possível iniciar o Supabase.", e);
    sb = null;
  }
  if (sb) {
    pronto = (async function () {
      var atual = await sb.auth.getSession();
      if (atual.data && atual.data.session) return atual.data.session;
      var novo = await sb.auth.signInAnonymously();
      if (novo.error) throw novo.error;
      return novo.data.session;
    })().catch(function (e) {
      console.warn("Destrave: não foi possível abrir a sessão no Supabase.", e);
      return null;
    });
  } else {
    console.warn("Destrave: Supabase não configurado (confira config.js).");
    pronto = Promise.resolve(null);
  }

  async function token() {
    if (!(await pronto)) return null;
    var s = await sb.auth.getSession();
    return s.data && s.data.session ? s.data.session.access_token : null;
  }
  async function idDaPessoa() {
    var s = await pronto;
    return s && s.user ? s.user.id : null;
  }
  function erro(code, message, text) {
    var e = { code: code, message: message || code };
    if (text) e.text = text;
    return e;
  }

  /* ---------- IA ("sample") ---------- */
  async function chamar(input, opts, json) {
    opts = opts || {};
    if (opts.signal && opts.signal.aborted) throw erro("cancelled");
    var t = await token();
    if (!t) throw erro("not_granted", "Sem sessão.");
    var r;
    try {
      r = await fetch("/api/ia", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + t },
        body: JSON.stringify({ input: input, json: !!json, modelTier: opts.modelTier || "default" }),
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw erro("cancelled");
      throw erro("upstream_error", "Sem conexão com o servidor.");
    }
    var d = {};
    try { d = await r.json(); } catch (e) {}
    if (!r.ok) throw erro(d.code || (r.status === 429 ? "rate_limited" : "upstream_error"), d.message);
    var text = String(d.text || "");
    if (!text.trim()) throw erro("empty_completion");
    if (opts.signal && opts.signal.aborted) throw erro("cancelled", "", text);
    if (typeof opts.onText === "function") { try { opts.onText({ text: text, delta: text }); } catch (e) {} }
    return { text: text, truncated: !!d.truncated, modelTierApplied: opts.modelTier || "default" };
  }
  // Lê a resposta como JSON do jeito tolerante: o texto inteiro, um bloco de código, ou do primeiro { ou [ ao último } ou ].
  function lerJSON(t) {
    try { return JSON.parse(t); } catch (e) {}
    var m = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
    if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    var a = t.search(/[{[]/), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    return undefined;
  }
  var sample = function (input, opts) { return chamar(input, opts, false); };
  sample.json = async function (input, opts) {
    var r = await chamar(input, opts, true);
    if (r.truncated) throw erro("invalid_json", "Resposta cortada.", r.text);
    var v = lerJSON(r.text);
    if (v === undefined) throw erro("invalid_json", "Resposta sem JSON.", r.text);
    return v;
  };
  sample.limits = async function () { return { maxPromptBytes: 262144 }; };

  /* ---------- Quem está usando ("user") ---------- */
  var user = {
    isOwner: async function () { return false; },
    canEdit: async function () { return false; },
    id: idDaPessoa,
    me: async function () { return { id: await idDaPessoa() }; },
  };

  /* ---------- Base de dados ("db"): tabela "docs" do Supabase ---------- */
  function doc(caminho) {
    return {
      get: async function () {
        var q = await sb.from("docs").select("dados").eq("caminho", caminho).maybeSingle();
        if (q.error) throw erro("unavailable", q.error.message);
        return { exists: !!q.data, data: function () { return q.data ? q.data.dados : undefined; } };
      },
      set: async function (dados) {
        var q = await sb.from("docs").upsert({ caminho: caminho, dono: await idDaPessoa(), dados: dados, atualizado_em: new Date().toISOString() });
        if (q.error) throw erro("unavailable", q.error.message);
      },
      update: async function (parte) {
        var atual = await this.get();
        await this.set(Object.assign({}, atual.exists ? atual.data() : {}, parte));
      },
      delete: async function () {
        var q = await sb.from("docs").delete().eq("caminho", caminho);
        if (q.error) throw erro("unavailable", q.error.message);
      },
    };
  }
  var db = {
    doc: doc,
    // O painel ao vivo do dono não existe fora do Claude: os dados ficam no Supabase (Table Editor).
    collection: function () {
      return { onSnapshot: function (next) { try { next({ docs: [], size: 0, empty: true }); } catch (e) {} return function () {}; } };
    },
  };

  window.claude = {
    use: async function (nome) {
      if (nome === "sample") return sample;
      if (nome === "user") return (await pronto) ? user : null;
      if (nome === "db") return (await pronto) ? db : null;
      return null;
    },
  };
})();
