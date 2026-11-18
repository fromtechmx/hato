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

## Límites y riesgos pendientes

- Datos locales en el celular sin cifrar; en celulares compartidos, cerrar sesión avisa si hay pendientes.
- Piloto con email/contraseña creados por admin; no hay OTP por teléfono.
- Canal WhatsApp (Zapia vs WhatsApp Cloud API) sin decidir; Zapia no entrega el número del remitente (prueba 1), pruebas 2 y 3 sin correr.
- Regla de conflicto si el mismo evento llega por app y por WhatsApp: sin definir.
- El detector de teléfonos de `zapia-spike` da falsos positivos (IPs/trace IDs); pendiente corregir.
- Gobernanza de datos con la cooperativa y región del proyecto (us-west-2) por definir.
- Sin edición ni borrado: se corrige con un evento `anulacion` (diseño intencional, auditable).
