"""E2E de los paneles en Chromium contra un Supabase SIMULADO (test/e2e-paneles-server.mjs)."""
import json, subprocess, time, urllib.request
from playwright.sync_api import sync_playwright

APP = 'http://127.0.0.1:4173/'
fallos = []
def check(c, m):
    print(('OK   ' if c else 'FALLA'), m)
    if not c: fallos.append(m)
def servidor(): return json.load(urllib.request.urlopen('http://127.0.0.1:4175/'))

srv = subprocess.Popen(['node', 'test/e2e-paneles-server.mjs'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(1.2)

def entrar(br, correo):
    ctx = br.new_context(viewport={'width': 390, 'height': 900}, locale='es-MX', timezone_id='America/Mexico_City', service_workers='allow')
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.goto(APP)
    page.fill('#email', correo); page.fill('#pass', 'clave-de-prueba'); page.click('#btnLogin')
    page.wait_for_selector('text=✓ Todo enviado', timeout=8000)
    return ctx, page, errs

try:
    with sync_playwright() as p:
        br = p.chromium.launch()

        # ---------- Veterinario ----------
        ctx, page, errs = entrar(br, 'vet@test.invalid')
        body = page.inner_text('main')
        check('Panel del veterinario' in body, 'el veterinario ve su panel')
        check('Panel de la asociación' not in body, 'el veterinario NO ve el panel de asociación')
        check('hay visitas urgentes' in body, 'el botón avisa que hay visitas urgentes')
        page.click('text=Panel del veterinario')
        page.wait_for_selector('text=Visitar esta semana')
        tarjetas = page.locator('.card').all_inner_texts()
        nombres = [t.split('\n')[0] for t in tarjetas if t.startswith('Rancho')]
        print('   orden:', nombres)
        check(nombres[:4] == ['Rancho La Visita', 'Rancho El Llamar', 'Rancho Sin Datos', 'Rancho Tranquilo'], 'ranchos ordenados: visitar, llamar, sin datos, sin urgencia')
        t = {n: tx for n, tx in zip(nombres, [x for x in tarjetas if x.startswith('Rancho')])}
        check('Visitar esta semana' in t['Rancho La Visita'] and '6' in t['Rancho La Visita'], 'La Visita: visitar y 6 por diagnosticar')
        check('Llamar primero' in t['Rancho El Llamar'], 'El Llamar: llamar primero')
        check('Llamar: sin datos recientes' in t['Rancho Sin Datos'] and 'hace 20 días' in t['Rancho Sin Datos'], 'Sin Datos: aviso por 20 días sin datos aunque no tenga pendientes')
        check('Sin urgencia' in t['Rancho Tranquilo'], 'Tranquilo: sin urgencia')
        check('Próximos pendientes por fecha' in page.inner_text('main'), 'muestra próximos pendientes por fecha')
        check('provisionales' in page.inner_text('main'), 'avisa que las reglas son provisionales')
        page.screenshot(path='/tmp/hato_panel_vet.png', full_page=True)
        # sin internet: recargar y volver a abrir el panel
        ctx.set_offline(True)
        page.reload(); page.wait_for_selector('text=Panel del veterinario')
        page.click('text=Panel del veterinario'); page.wait_for_selector('text=Visitar esta semana')
        check(True, 'el panel funciona sin internet tras recargar')
        ctx.set_offline(False)
        # abrir vacas de un rancho desde el panel
        page.click('.card:has-text("Rancho La Visita") >> text=Ver vacas')
        page.wait_for_selector('.vaca')
        check(page.locator('.vaca').count() == 6 and 'Rancho La Visita' in page.inner_text('header.top'), '“Ver vacas” abre las 6 vacas de ese rancho')
        check(not errs, 'sin errores de JavaScript (veterinario)')
        ctx.close()

        # ---------- Vaquero: no pide insumos ----------
        ctx, page, errs = entrar(br, 'vaquero@test.invalid')
        check('Pedir insumos' not in page.inner_text('main'), 'el vaquero no ve “Pedir insumos”')
        check('Panel' not in page.inner_text('main'), 'el vaquero no ve paneles')
        ctx.close()

        # ---------- Ganadero (dueño): pide y cancela ----------
        ctx, page, errs = entrar(br, 'ganadero@test.invalid')
        check('Panel del veterinario' not in page.inner_text('main') and 'Panel de la asociación' not in page.inner_text('main'), 'el ganadero no ve paneles de veterinario ni asociación')
        page.click('text=Pedir insumos'); page.wait_for_selector('#insumo')
        page.fill('#cantidad', 'abc'); page.select_option('#insumo', label='Pajillas de semen (pajilla)')
        page.click('text=Enviar solicitud')
        check('entero' in page.inner_text('.aviso.mal'), 'cantidad inválida muestra error y conserva el formulario')
        check(page.input_value('#insumo') != '' and page.input_value('#cantidad') == 'abc', 'no se pierde lo escrito tras el error')
        page.fill('#cantidad', '12'); page.click('text=Enviar solicitud')
        page.wait_for_selector('text=Pendiente')
        check(page.input_value('#cantidad') == '' and page.input_value('#insumo') == '', 'tras enviar, el formulario queda limpio')
        check(any(s['rancho'] == 'Rancho Del Ganadero' and s['cantidad'] == 12 and s['estado'] == 'pendiente' for s in servidor()['solicitudes']), 'la solicitud llegó al servidor, a nombre de su rancho')
        page.click('text=Cancelar'); page.wait_for_selector('.estado:has-text("Cancelada")')
        check(any(s['rancho'] == 'Rancho Del Ganadero' and s['estado'] == 'cancelada' for s in servidor()['solicitudes']), 'pudo cancelar una solicitud pendiente')
        # pedir otra y dejarla pendiente para la consolidación
        page.select_option('#insumo', label='Guantes de palpación (caja)'); page.fill('#cantidad', '5'); page.click('text=Enviar solicitud')
        page.wait_for_selector('text=5 caja')
        ctx.set_offline(True)
        page.select_option('#insumo', label='Pajillas de semen (pajilla)'); page.fill('#cantidad', '7'); page.click('text=Enviar solicitud')
        page.wait_for_selector('.aviso.mal:has-text("Sin conexión")')
        check(True, 'sin internet avisa claramente (los pedidos necesitan conexión)')
        ctx.set_offline(False)
        check(not errs, 'sin errores de JavaScript (ganadero)')
        ctx.close()

        # ---------- Administrador de la asociación ----------
        ctx, page, errs = entrar(br, 'admin@test.invalid')
        check('Panel de la asociación' in page.inner_text('main') and 'Panel del veterinario' not in page.inner_text('main'), 'el administrador ve solo el panel de la asociación')
        check('Registrar evento' not in page.inner_text('main'), 'el administrador sin rancho no ve el registro de vacas')
        page.click('text=Panel de la asociación'); page.wait_for_selector('text=Demanda pendiente')
        d = page.inner_text('main')
        check('Pajillas de semen · 65 pajilla' in d, 'suma las pajillas de todos los ranchos (40+25)')
        check('Guantes de palpación · 10 caja' in d, 'suma los guantes (3+2+5)')
        check('Rancho La Visita: 40' in d and 'Rancho El Llamar: 25' in d, 'desglose por rancho')
        check('cancelada' not in d.lower().split('demanda pendiente')[1].split('crear compra')[0], 'la solicitud cancelada no cuenta como demanda')
        # desmarcar guantes y consolidar solo pajillas
        page.locator('label:has-text("Guantes de palpación") input[type=checkbox]').uncheck()
        page.fill('#destinatario', 'Dr. Prueba'); page.select_option('#tipoDest', 'veterinario')
        page.click('button:has-text("Crear compra consolidada")')
        page.wait_for_selector('.ev:has-text("Dr. Prueba")')
        check(page.input_value('#destinatario') == '', 'tras consolidar, el formulario queda limpio')
        sv = servidor()
        check(all(s['estado'] == 'consolidada' for s in sv['solicitudes'] if s['insumo'] == 'Pajillas de semen' and s['estado'] != 'cancelada'), 'las pajillas pendientes quedaron consolidadas')
        check(all(s['estado'] == 'pendiente' for s in sv['solicitudes'] if s['insumo'] == 'Guantes de palpación'), 'los guantes (desmarcados) siguen pendientes')
        check(len(sv['ordenes']) == 1 and sv['ordenes'][0]['destinatario'] == 'Dr. Prueba', 'se creó una sola orden al destinatario')
        main = page.inner_text('main')
        check('Pajillas de semen: 65 pajilla' in main, 'la orden muestra el total consolidado')
        page.click('text=Marcar como enviada'); page.wait_for_selector('.estado:has-text("Enviada")')
        page.click('text=Marcar como recibida'); page.wait_for_selector('.estado:has-text("Recibida")')
        check(servidor()['ordenes'][0]['estado'] == 'recibida', 'la orden avanza a recibida')
        # catálogo
        page.fill('#insNombre', 'Vitaminas'); page.fill('#insUnidad', 'frasco'); page.click('text=Agregar al catálogo')
        page.wait_for_selector('.ev:has-text("Vitaminas")')
        check(page.input_value('#insNombre') == '' and page.input_value('#insUnidad') == '', 'tras agregar insumo, el formulario queda limpio')
        check('Vitaminas' in servidor()['insumos'], 'agrega un insumo al catálogo')
        page.screenshot(path='/tmp/hato_panel_asoc.png', full_page=True)
        check(not errs, 'sin errores de JavaScript (administrador)')
        ctx.close()

        br.close()
finally:
    srv.terminate()

print('\nRESULTADO:', 'TODO OK' if not fallos else f'{len(fallos)} FALLA(S): {fallos}')
raise SystemExit(1 if fallos else 0)
