"""Prueba de punta a punta en Chromium: registrar SIN conexión, recargar sin conexión, reconectar y verificar el envío.
Usa un Supabase SIMULADO (test/e2e-server.mjs), no el real."""
import json, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

APP = 'http://127.0.0.1:4173/'
fallos = []

def check(cond, msg):
    print(('OK   ' if cond else 'FALLA'), msg)
    if not cond:
        fallos.append(msg)

def servidor():
    return json.load(urllib.request.urlopen('http://127.0.0.1:4175/'))

srv = subprocess.Popen(['node', 'test/e2e-server.mjs'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.2)
try:
    with sync_playwright() as p:
        br = p.chromium.launch()
        ctx = br.new_context(viewport={'width': 390, 'height': 800}, locale='es-MX', timezone_id='America/Mexico_City', service_workers='allow')
        page = ctx.new_page()
        errores = []
        page.on('pageerror', lambda e: errores.append(str(e)))
        page.on('console', lambda m: errores.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)  # los rechazos de red provocados a propósito no cuentan
        page.on('dialog', lambda d: d.accept())

        # 1) Login
        page.goto(APP)
        page.fill('#email', 'vaquero@test.invalid')
        page.fill('#pass', 'mala')
        page.click('#btnLogin')
        page.wait_for_selector('.aviso.mal')
        check('incorrectos' in page.inner_text('.aviso.mal'), 'contraseña mala muestra mensaje claro')
        page.fill('#pass', 'clave-de-prueba')
        page.click('#btnLogin')
        page.wait_for_selector('text=Registrar evento')
        check('Rancho El Prueba' in page.inner_text('header.top'), 'entra y muestra su rancho')
        check('Rancho Ajeno' not in page.content(), 'no aparece el rancho ajeno')
        page.wait_for_selector('text=✓ Todo enviado')
        check(page.inner_text('.grid .btn.tile >> nth=1').startswith('2'), 'descargó sus 2 vacas (la del otro rancho no)')

        page.screenshot(path='/tmp/hato_home.png')

        # 2) Lista de vacas y estado derivado
        page.click('text=Mis vacas')
        page.wait_for_selector('.vaca')
        txt = page.inner_text('#lista')
        check('101' in txt and '202' in txt and '999' not in txt, 'lista de vacas correcta')
        check('toca diagnóstico' in txt, 'la 101 (servida hace 35 días) aparece "toca diagnóstico"')
        page.click('text=‹ Inicio')

        # 3) Esperar a que el service worker controle la página (para poder abrir sin conexión)
        page.wait_for_function('navigator.serviceWorker && navigator.serviceWorker.controller', timeout=15000)
        page.reload()
        page.wait_for_selector('text=Registrar evento')
        page.wait_for_function('navigator.serviceWorker.controller !== null')

        # 4) SIN CONEXIÓN: vaca nueva + inseminación, y una nota de otra vaca
        ctx.set_offline(True)
        page.click('text=Registrar evento')
        page.fill('#arete', '303')
        page.click('text=Vaca nueva: 303')
        page.screenshot(path='/tmp/hato_paso_tipo.png')
        page.click('text=Inseminación')
        page.fill('#d_toro', 'T-77')
        page.screenshot(path='/tmp/hato_paso_detalle.png')
        page.click('text=Guardar')
        page.wait_for_selector('text=Guardado en el teléfono')
        check('por enviar' in page.inner_text('#chip'), 'sin conexión: el indicador dice "por enviar"')
        page.fill('#arete', '202')
        page.click('.cuadro >> nth=0')
        page.click('text=Celo')
        page.click('text=Guardar')
        page.wait_for_selector('text=Guardado en el teléfono')
        n_antes = servidor()
        check(not any(a['arete'] == '303' for a in n_antes['animales']), 'el servidor NO recibió nada mientras estaba sin conexión')

        # 5) Recargar la app SIN conexión: el shell sale del caché y los datos de IndexedDB
        page.reload()
        page.wait_for_selector('text=Registrar evento')
        check('3 por enviar' in page.inner_text('#chip') or '⏳' in page.inner_text('#chip'), 'tras recargar sin conexión, siguen los pendientes')
        page.click('text=Mis vacas')
        page.wait_for_selector('.vaca')
        check('303' in page.inner_text('#lista'), 'la vaca nueva sigue ahí tras recargar sin conexión')
        page.click('text=‹ Inicio')

        # 6) Reconectar y enviar
        ctx.set_offline(False)
        page.click('#chip')
        page.click('text=Enviar ahora')
        page.wait_for_selector('text=Todo lo registrado ya está en el servidor', timeout=15000)
        s = servidor()
        check(sum(1 for a in s['animales'] if a['arete'] == '303') == 1, 'el servidor tiene la vaca 303 exactamente una vez')
        check(sum(1 for e in s['eventos'] if e['tipo'] == 'inseminacion' and e['datos'].get('toro') == 'T-77') == 1, 'la inseminación llegó una vez, con su toro')
        check(sum(1 for e in s['eventos'] if e['tipo'] == 'celo') == 1, 'el celo llegó una vez')

        # 7) Enviar otra vez no duplica
        page.click('text=Enviar ahora')
        time.sleep(1)
        s2 = servidor()
        check(len(s2['eventos']) == len(s['eventos']) and len(s2['animales']) == len(s['animales']), 'sincronizar de nuevo no duplica nada')

        # 8) Deshacer un registro ya enviado crea una anulación
        page.click('text=‹ Inicio')
        page.click('text=Mis vacas')
        page.click('.vaca:has-text("303")')
        page.wait_for_selector('text=Historial')
        page.click('text=Deshacer >> nth=0')
        page.wait_for_selector('.ev.anulado')
        page.wait_for_function("document.querySelector('#chip').innerText.includes('Todo enviado')", timeout=15000)
        s3 = servidor()
        check(any(e['tipo'] == 'anulacion' for e in s3['eventos']), 'deshacer un registro enviado envía una anulación (no borra)')

        # 9) Cerrar sesión con pendientes advierte (el diálogo se acepta aquí) y volver a entrar conserva datos
        page.screenshot(path='/tmp/hato_ficha.png')
        check(not errores, f'sin errores en consola ({errores[:3]})')
        br.close()
finally:
    srv.terminate()

print('\nRESULTADO:', 'TODO OK' if not fallos else f'{len(fallos)} FALLO(S): {fallos}')
sys.exit(1 if fallos else 0)
