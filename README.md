# socket-transcript — Uso de salas con contraseña

Breve guía de uso para el Durable Object WebSocket implementado en `src/index.ts`.

Resumen rápido
- Endpoint de WS: `/rooms/{ROOM_NAME}`
- Primer cliente debe crear la sala enviando un mensaje de autenticación con `action: "create"` y una `password`.
- Usuarios siguientes deben enviar `action: "join"` y la misma `password`.
- El `alias` es opcional y permite identificar al usuario en los mensajes.
- La contraseña se almacena en memoria (hash SHA-256) y se borra automáticamente cuando la última conexión cierra.

Formato de mensajes de autenticación (inmediato tras abrir la conexión)
- JSON recomendado:

```
{"action": "create" | "join", "password": "TU_PASS", "alias": "MiAlias"}
```

- Alternativa corta (texto):

```
create:TU_PASS:MiAlias
join:TU_PASS:MiAlias
```

Respuestas del servidor (JSON)
- Éxito creación:

```
{"type":"success","code":"created","message":"Room created","alias":"user-abc123"}
```

- Éxito unión:

```
{"type":"success","code":"joined","message":"Joined room","alias":"MiAlias"}
```

- Mensaje de chat (broadcast):

```
{"type":"message","from":"Alias","payload": <original payload>}
```

- Errores de autenticación / formato:

```
{"type":"error","code":"invalid_password","message":"Invalid password"}
```

Ejemplo en navegador

```html
<script>
const ws = new WebSocket('wss://TU_DOMINIO/rooms/mi-sala');
ws.onopen = () => {
  // crear sala
  ws.send(JSON.stringify({ action: 'create', password: 'secreto', alias: 'Alice' }));
};
ws.onmessage = (e) => {
  console.log('recv:', e.data);
};
// luego, para enviar un mensaje "chat":
// ws.send('Hola a todos');
</script>
```

Ejemplo en Node.js (paquete `ws`)

```js
const WebSocket = require('ws');
const ws = new WebSocket('wss://TU_DOMINIO/rooms/mi-sala');
ws.on('open', () => {
  ws.send(JSON.stringify({ action: 'join', password: 'secreto', alias: 'Bob' }));
});
ws.on('message', (data) => console.log('recv:', data));
// Enviar mensaje de chat (después de autenticar):
// ws.send('Hola desde Node');
```

Pruebas rápidas desde línea de comandos
- Con `wscat` (npm install -g wscat):

```bash
wscat -c wss://TU_DOMINIO/rooms/mi-sala
# una vez conectado, enviar JSON de auth:
# {"action":"create","password":"secreto","alias":"Alice"}
```

Notas de seguridad y mejoras posibles
- Actualmente el hash se mantiene en memoria del Durable Object y se borra cuando la última conexión cierra. Si necesitas persistir contraseña a largo plazo, cambia la lógica para usar `this.state.storage` con un hash+salt.
- Considera limitar intentos de login o agregar expiración/rotación basada en tiempo.

Si quieres, puedo:
- Añadir ejemplos con `websocat` o `curl`-like pruebas.
- Cambiar el almacenamiento a persistente y hashear con salt.
- Añadir mensajes más detallados (códigos numéricos) o un endpoint HTTP para administración de la sala.
