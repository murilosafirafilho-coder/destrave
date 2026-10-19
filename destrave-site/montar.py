"""Monta o index.html do site a partir do arquivo do app, sem alterar o código do app:
só acrescenta o cabeçalho da página (ícone, nome na tela de início) e carrega a ponte antes do app.
Uso: python3 montar.py caminho/do/destrave-app.html"""
import sys, pathlib

app = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
aqui = pathlib.Path(__file__).resolve().parent

cabecalho = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Destrave o Sucesso em 7 Dias</title>
<meta name="description" content="Desafio de 7 dias com plano pessoal para destravar sua rotina.">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icone-192.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#2747C9">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Destrave">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<script src="/config.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script src="/ponte.js"></script>
</head>
<body>
"""
(aqui / "index.html").write_text(cabecalho + app + "\n</body>\n</html>\n", encoding="utf-8")
print("index.html montado:", len(app), "caracteres do app, sem alterações.")
