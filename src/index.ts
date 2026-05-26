import { DurableObject } from "cloudflare:workers";

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject<Env> {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * The Durable Object exposes an RPC method sayHello which will be invoked when when a Durable
	 *  Object instance receives a request from a Worker via the same method invocation on the stub
	 *
	 * @param name - The name provided to a Durable Object instance from a Worker
	 * @returns The greeting to be sent back to the Worker
	 */
	async sayHello(name: string): Promise<string> {
		return `Hello, ${name}!`;
	}
}

export class WebSocketDurableObject extends DurableObject<Env> {
	connections: Set<WebSocket>;
	private passwordHash?: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.connections = new Set();
		this.passwordHash = undefined;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response(JSON.stringify({ error: 'expected_websocket', message: 'Expected websocket upgrade' }), { status: 400, headers: { 'content-type': 'application/json' } });
		}

		const [ client, server ] = Object.values(new WebSocketPair()) as [ WebSocket, WebSocket ];
		server.accept();

		// helper to compute sha256 hex
		const sha256Hex = async (message: string) => {
			const enc = new TextEncoder();
			const msgUint8 = enc.encode(message);
			const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		};

		// Authentication + message handling
		server.addEventListener("message", async (event) => {
			try {
				const raw = typeof event.data === 'string' ? event.data : '';
				let action: string | undefined;
				let password: string | undefined;
				let alias: string | undefined;

				// Try JSON first: { action: 'create'|'join', password: '...', alias?: 'name' }
				try {
					const obj = JSON.parse(raw);
					if (obj && (obj.action === 'create' || obj.action === 'join') && typeof obj.password === 'string') {
						action = obj.action;
						password = obj.password;
						if (typeof obj.alias === 'string' && obj.alias.trim() !== '') alias = obj.alias.trim();
					}
				} catch {}

				// Fallback to colon format: "create:password[:alias]" or "join:password[:alias]"
				if (!action) {
					const parts = raw.split(':');
					if (parts.length >= 2) {
						action = parts.shift();
						password = parts.shift();
						if (parts.length) alias = parts.join(':') || undefined;
					}
				}

				// If connection not authenticated yet, expect create/join
				if (!(server as any)._authenticated) {
					if (!action || !password) {
						server.send(JSON.stringify({ type: 'error', code: 'auth_required', message: 'Expecting auth message', hint: '{"action":"create|join","password":"..."}' }));
						server.close(1008);
						return;
					}

					const hashed = await sha256Hex(password);
					if (!this.passwordHash) {
						// room not yet created -> only allow create
						if (action !== 'create') {
							server.send(JSON.stringify({ type: 'error', code: 'room_not_created', message: 'Room not created. Send action "create" with a password.' }));
							server.close(1008);
							return;
						}
						this.passwordHash = hashed;
						(server as any)._authenticated = true;
						// set alias if provided, otherwise create a short one
						(server as any)._alias = alias ?? `user-${Math.random().toString(36).slice(2,8)}`;
						this.connections.add(server);
						server.send(JSON.stringify({ type: 'success', code: 'created', message: 'Room created', alias: (server as any)._alias }));
						return;
					} else {
						// room exists -> require join and matching password
						if (action !== 'join') {
							server.send(JSON.stringify({ type: 'error', code: 'room_exists', message: 'Room already created. Send action "join" with password.' }));
							server.close(1008, 'Error de creación, la sala ya existe');
							return;
						}
						if (hashed !== this.passwordHash) {
							server.send(JSON.stringify({ type: 'error', code: 'invalid_password', message: 'Invalid password' }));
							server.close(1008, 'Error de ingreso, contaseña incorrecta');
							return;
						}
						(server as any)._authenticated = true;
						(server as any)._alias = alias ?? `user-${Math.random().toString(36).slice(2,8)}`;
						this.connections.add(server);
						// server.send(JSON.stringify({ type: 'success', code: 'joined', message: 'Joined room', alias: (server as any)._alias }));
						for (const conn of this.connections) {
							conn.send(JSON.stringify({ type: 'success', code: 'joined', message: 'Joined room', alias: (server as any)._alias }))
						}
						return;
					}
				}

				// If authenticated, broadcast normal messages to other connections with sender alias
				if ((server as any)._authenticated) {
					const senderAlias = (server as any)._alias ?? 'unknown';
					const payload = event.data;
					const data = JSON.parse(payload);
					if (data.type === "ping") {
						server.send(JSON.stringify({ type: "pong" }));
						console.log(`${senderAlias} - Ping`);
					} else if (data.type === "message") {
						const out = JSON.stringify({ type: 'message', from: senderAlias, content: payload });
						for (const conn of this.connections) {
							// if (conn !== server) conn.send(out);
							conn.send(out);
						}

					}
				}
			} catch (err) {
				console.error('WS message handler error', err);
			}
		});

		server.addEventListener("close", (event) => {
			console.log("Cierre recibido del cliente", event.code, event.reason);
			if (event.code !== 1008) {
				for (const conn of this.connections) {
					conn.send(JSON.stringify({ type: 'success', code: 'left', message: 'Left room', alias: (server as any)._alias }))
				}
			}

			try {
				server.close(event.code, event.reason);				
			} catch (error) {
				console.log(`Error: ${error}`);
			}
			this.connections.delete(server);
			// If last connection closed, clear in-memory password (rotation/deletion)
			if (this.connections.size === 0) {
				this.passwordHash = undefined;
				console.log('All connections closed: cleared room password');
			}
		});

		server.addEventListener("error", (event) => {
			console.log(event)
		})

		return new Response(null, { status: 101, webSocket: client });
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request, env, ctx): Promise<Response> {

		const url = new URL(request.url);

		const m = url.pathname.match(/^\/rooms\/([^/]+)$/);
		if (!m) return new Response("Not found", { status: 404 });
		
		const roomName = decodeURIComponent(m[1]);
		const wsStub = env.WS_DURABLE_OBJECT.getByName(roomName);
		return await wsStub.fetch(request);
	},
} satisfies ExportedHandler<Env>;
