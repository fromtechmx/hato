# HATO — App de registro reproductivo (etapa 1, piloto con datos sintéticos)

PWA instalable: registra celos, inseminaciones, diagnósticos, partos, etc. **sin internet** y envía a Supabase cuando hay wifi. Cada rancho ve solo sus animales (RLS en Supabase).

## Estado real (léelo antes de usarla)

| Verificado | No verificado |
|---|---|
| 25 pruebas de lógica y sincronización (node) | Contra el Supabase real: **nada**. El sandbox no alcanza supabase.co; todo se probó contra un simulador |
| Flujo completo en Chromium: login, registro offline, recarga offline, reconexión, sin duplicados, deshacer | Celular real (Android/iPhone) |
| Esquema y aislamiento RLS (23 chequeos SQL en Supabase) | Sintaxis `or=(...)` de paginación, `rancho:ranchos(...)` y `on_conflict` contra PostgREST real |
| | Iconos/instalación en iPhone; borrado de datos de PWAs no instaladas en iOS |

Reglas clínicas (`PARAMS` en `lib.js`: diagnóstico 30 d, gestación 283 d, espera 45 d, aviso parto 15 d) son **supuestos pendientes de validar por un MVZ**.

## 1. Publicar (necesita HTTPS)

El service worker y la instalación exigen HTTPS. Sube la carpeta `app/` completa a un hosting estático (opciones comunes: Netlify Drop, GitHub Pages, Cloudflare Pages; no las probé desde aquí). La raíz del sitio debe ser el contenido de `app/` (donde está `index.html`).

`config.js` ya trae la URL del proyecto y la clave **publishable** (pública por diseño). Nunca pongas `service_role` ni `sb_secret_` ahí.

## 2. Primera prueba contra el Supabase real

1. Dashboard → Authentication → Providers → Email: **desactiva "Allow new users to sign up"** (si no, cualquiera con la clave pública puede crear cuentas).
2. Authentication → Users → Add user (email + contraseña, "Auto Confirm User").
3. Crea datos sintéticos y liga al usuario (SQL Editor, cambia el UUID por el del usuario creado):

```sql
with c as (insert into cooperativas(nombre) values ('Cooperativa DEMO') returning id),
s as (insert into socios(cooperativa_id, nombre) select id,'Socio DEMO' from c returning id),
r as (insert into ranchos(socio_id, nombre) select id,'Rancho DEMO' from s returning id)
insert into membresias(user_id, rancho_id, rol, activo)
select 'UUID-DEL-USUARIO', id, 'dueno', true from r;
```
(Si algún nombre de columna difiere, revisa la migración `hato_etapa1_esquema_base`.)

4. Abre la app, entra, registra una vaca con wifi y confirma en Table Editor que aparece en `animales`/`eventos`. Luego repite en modo avión y reconecta. **Esa prueba es la que falta**; si falla `or=` o `on_conflict`, el cambio es chico (`sync.js`).

## 3. Pruebas locales

```
cd test
TZ=America/Mexico_City node --test        # 25 pruebas
python3 e2e.py                            # navegador (requiere playwright + chromium)
```


## Paneles por rol (fases 2 y 3)

Qué ve cada quien lo decide la base de datos, no la app:

| Rol | Cómo se asigna | Ve |
|---|---|---|
| Dueño / vaquero | `membresias` con rol `dueno` o `vaquero` | Solo su rancho. El dueño además pide insumos |
| Veterinario | `membresias` con rol `mvz` en cada rancho que atiende | Panel del veterinario (todos sus ranchos, también sin internet) |
| Administrador de asociación | fila en `admins_cooperativa` | Panel de la asociación: demanda de insumos y compras consolidadas. **No ve vacas ni eventos** |

Ejemplo para dar de alta (cambia los UUID):
```sql
insert into membresias(user_id, rancho_id, rol, activo) values ('USER', 'RANCHO', 'mvz', true);
insert into admins_cooperativa(user_id, cooperativa_id) values ('USER', 'COOP');
```

Datos de demostración en Supabase: 5 ranchos sintéticos (A a E), vacas con `nombre = 'SIM'`, un catálogo de 6 insumos y 6 solicitudes. Tu usuario es dueño de A, veterinario de B a E y administrador de la cooperativa DEMO. Para limpiar la simulación: borrar eventos con `datos->>'sim' = 'true'` y luego las vacas con `nombre = 'SIM'`.

### Reglas provisionales del panel del veterinario (sin validar por un MVZ)
- 5 o más vacas por diagnosticar o con parto próximo en un rancho → "Visitar".
- Menos de 5 pero con vacas por atender → "Llamar primero".
- Más de 14 días sin que el servidor reciba datos → "Llamar: sin datos recientes" (cero pendientes con datos viejos no es buena noticia).
- Si no, "Sin urgencia", con la fecha en que aparecerán los siguientes pendientes.
Se ajustan en `UMBRALES` y `PARAMS` de `lib.js`.

### Límites de las fases 2 y 3
- Pedir insumos y el panel de la asociación **necesitan internet** (no hay cola sin conexión como en el registro de vacas).
- Una compra consolidada no se puede cancelar desde la app, y cancelarla no liberaría las solicitudes. Falta definir ese flujo.
- Los insumos no se calculan solos a partir de los eventos (por ejemplo, pajillas según inseminaciones): los ranchos piden y la asociación junta.
- El administrador ve qué rancho pidió qué. Hay que acordar con la cooperativa si esa visibilidad es aceptable para los socios.
- Si un administrador lo es de más de una cooperativa, la app muestra solo la primera.
- Probado: lógica (33 pruebas), navegador contra un Supabase simulado, y las reglas de acceso de las tablas nuevas en el Supabase real (20 chequeos con roles simulados). No probado: la app contra el Supabase real desde un navegador con los paneles nuevos, ni un celular real.
- La función `consolidar_solicitudes` es ejecutable por usuarios autenticados (el asesor de seguridad de Supabase lo marca como advertencia). Es intencional: verifica dentro que quien llama administra esa cooperativa, y eso se probó.

## Límites y riesgos pendientes

- Datos locales en el celular sin cifrar; en celulares compartidos, cerrar sesión avisa si hay pendientes.
- Piloto con email/contraseña creados por admin; no hay OTP por teléfono.
- Canal WhatsApp (Zapia vs WhatsApp Cloud API) sin decidir; Zapia no entrega el número del remitente (prueba 1), pruebas 2 y 3 sin correr.
- Regla de conflicto si el mismo evento llega por app y por WhatsApp: sin definir.
- El detector de teléfonos de `zapia-spike` da falsos positivos (IPs/trace IDs); pendiente corregir.
- Gobernanza de datos con la cooperativa y región del proyecto (us-west-2) por definir.
- Sin edición ni borrado: se corrige con un evento `anulacion` (diseño intencional, auditable).

## Compra consolidada: recepción, reparto y códigos

- **Código de compra**: `CC-AAAA-NNNN` (secuencia global, año en hora de México). **Código de entrega por rancho**: `CC-AAAA-NNNN-NN`. Se crean al consolidar.
- **Dónde se recepciona**: Panel de la asociación → compra en estado *Enviada* → "Registrar recepción". Se escribe cuánto llegó de cada insumo; la vista previa muestra qué toca a cada rancho antes de confirmar. Solo admin de la cooperativa (RPC `recibir_orden`).
- **Regla de reparto (PROVISIONAL, validar con la cooperativa)**: si llegó ≥ lo pedido, cada rancho recibe lo que pidió y el sobrante queda en la asociación. Si llegó menos, reparto proporcional con residuo mayor (empate: solicitud más antigua).
- **Entrega**: el admin marca "Entregada" (`marcar_entrega`); el rancho (dueño o MVZ) ve su código y "Confirmar que lo recibí" (`confirmar_entrega`). Cada rancho solo ve sus entregas.
- Una compra solo pasa de borrador a enviada por PATCH; *recibida* solo por `recibir_orden`.
- Pendiente: cancelar una compra consolidada (no libera las solicitudes).

## Corte semanal y necesidad estimada

- **Corte**: la cooperativa define día y hora (por defecto miércoles 18:00, solo un valor inicial) en Panel de la asociación → "Corte semanal" (RPC `configurar_corte`, solo admin). Se calcula con la hora del dispositivo.
- **Rancho**: ve "Corte semanal: … · faltan N" al pedir insumos. Lo pedido antes entra a la compra de la semana; después, a la siguiente.
- **Admin**: ve el próximo corte y cuántas solicitudes pendientes llegaron *antes del último corte* y siguen sin consolidar. La consolidación sigue siendo manual y revisada; nada se compra solo.
- **Sugerencia semanal**: por insumo, **cada rancho** (dueño o MVZ) elige la base ("Vacas por servir" o "Vacas por diagnosticar") y la cantidad por vaca en "Mi estimación semanal" (tabla `estimacion_insumo_rancho`, RPC `guardar_estimacion`). La asociación no la ve ni la cambia (RLS). El rancho ve `ceil(vacas × factor)` para los próximos 7 días, descuenta lo ya pedido en el ciclo (acumulado) y el botón "Pedir N" solo precarga el formulario.
  - Por servir: vacas en celo, abiertas, listas, o posparto que estarán listas en ≤ 7 días (cota superior: no todas se servirán).
  - Por diagnosticar: vacas que ya tocan diagnóstico o lo cumplirán en ≤ 7 días.
- **Límites**: los factores NO están validados (los fija cada rancho; sin configurar = no sugiere). Pendiente: las columnas viejas `insumos.estimar_*` y la función `configurar_estimacion` siguen en la BD (la app ya no las usa). Solo cubre insumos ligados a eventos reproductivos. Si el rancho no registra, la estimación sale baja (la app lo avisa si el último dato tiene más de 14 días). Un solo corte para toda la cooperativa. Sin aviso por WhatsApp (depende del canal).

## Selección en cuadros (teléfono)

- **¿Qué vaca?** (registrar evento): cuadros de 3 columnas (4 en pantalla ancha) con el arete grande y el estado en una palabra; las que requieren atención van con borde naranja. Orden por número (numérico: 9 antes que 10) o "Atención primero" (aparece con más de 6 vacas). Escribir en el buscador filtra los cuadros; si no existe el arete, ofrece crear vaca nueva.
- **Pedir insumos**: el insumo se elige tocando un cuadro (ya no es un menú desplegable).
- Pendiente: "Mis vacas" y "Por atender" siguen siendo lista con detalle, no cuadros.

- **Acumulado del ciclo**: en "Pedir insumos" una tarjeta suma, por insumo, lo pedido desde el último corte (pendiente o ya consolidado; las canceladas no cuentan). Al pasar el corte, el acumulado empieza de nuevo. La sugerencia descuenta este acumulado (no solo lo pendiente), para que no vuelva a pedir lo que la cooperativa ya consolidó.

## Por atender priorizado y "Sin datos" (veterinario y ranchero)

- "Ver vacas por atender" (panel del veterinario) y "Por atender" (inicio) abren una vista con dos pestañas:
  - **Por ver (N)**: las vacas con alerta, en cuadros agrupados por motivo y en este orden: toca diagnóstico (más días sin diagnosticar primero), parto próximo (fecha más cercana primero), en celo, vacías (más días primero), listas para servicio. N coincide con las vacas en alerta del panel.
  - **Sin datos (M)**: vacas a averiguar, en este orden: parto vencido (gestante sin parto registrado más de 21 días después de lo esperado), sin movimiento (último registro hace más de 120 días y no gestante), solo notas/tratamientos sin parto/servicio/diagnóstico, sin ningún registro. Cada una dice el motivo. Una vaca puede aparecer en ambas pestañas (borde punteado en "Por ver").
- La tarjeta del rancho en el panel muestra "N vaca(s) sin datos o con datos que no cuadran" si las hay.
- Los umbrales (120 y 21 días) son PROVISIONALES: validarlos con un MVZ. "Sin datos" no distingue entre una vaca olvidada y una vaca que ya no está; por eso la acción sugerida es averiguar y registrar (descarte si ya no está).
- El botón de regreso de la ficha vuelve a la lista de donde se abrió.

- **Números del panel tocables**: en la tarjeta de cada rancho, "Toca diagnóstico", "Parto próximo" y "Celo, abiertas o listas" (si son mayores que cero) abren solo esas vacas, con el aviso "Mostrando N vaca(s)" y el botón "Ver todas". Al abrir una ficha y volver, el filtro se conserva.

- **Cuadros de vacas más compactos**: la cuadrícula se ajusta al ancho de la pantalla (cuadros de al menos 64 px): 5 por fila en un teléfono de 390 px, 4 en uno de 360 px y 8 o más en pantalla ancha. Para cambiar la densidad, modificar `minmax(64px, 1fr)` en `.cuadros` (index.html).

## Publicación (GitHub Pages)

La app vive en la **raíz** del repositorio (GitHub Pages sirve la raíz). No poner la app en una subcarpeta `app/`: el sitio no la vería. Las pruebas (`test/`) funcionan desde la raíz: `cd test && node --test` y `python3 test/e2e_paneles.py`.

- **Mis vacas** (todas las vacas del rancho) ahora se ve igual que "Por atender": cuadros agrupados por estado, primero lo que hay que ver (diagnóstico, parto próximo, celo, vacías, listas) y luego servidas, posparto, gestantes, sin datos y descartadas. El buscador filtra dentro de los grupos y el botón de regreso de la ficha vuelve a esta lista.


## Lo que faltó por llegar
- Si en la recepción llegó menos de lo pedido, la tarjeta de la compra muestra "Falta por llegar" con dos acciones del admin: **Generar compra con lo pendiente** (RPC `generar_orden_pendiente`: crea una compra nueva en borrador, con su código y entregas por rancho, marcada "Procede de CC-…") o **Cerrar sin reponer** (`cerrar_pendiente`).
- La original queda marcada (repuesta / cerrada) y ya no ofrece generarlo otra vez. El ranchero ve en su entrega "Faltaron N: los recibirás en CC-…-NN" y en la nueva "Procede de una entrega anterior". Lo repuesto no cuenta como pedido nuevo en el acumulado del ciclo.
- Límite: cancelar una compra consolidada sigue sin definirse.

## Compras para el veterinario de clínica
- En una compra dirigida a "Veterinario" el admin puede escribir el **correo** con el que el doctor entra a HATO (RPC `asignar_veterinario_orden`; guarda `veterinario_user_id` y `veterinario_correo`). El doctor no necesita ser MVZ de ningún rancho.
- El doctor ve en su inicio "Compras para mí" (RPC `mis_compras_vet`, solo `enviada`/`recibida`): código, estado, entrega estimada (orden + 3 días), total a surtir, qué rancho lleva qué y de dónde procede. No ve vacas ni registros ni el panel de la asociación. Se guarda en el teléfono para verlo sin internet.
- Límites: la cuenta del doctor debe existir (haber entrado una vez); el correo asignado no se valida contra la identidad real; el doctor no puede confirmar entrega aún; si cambias el correo de su cuenta, hay que reasignar.
