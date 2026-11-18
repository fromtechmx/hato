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
